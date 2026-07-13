import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const WAIT_TIMEOUT_MS = 20_000
const require = createRequire(import.meta.url)

function withTimeout(promise, label, stderr) {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      rejectPromise(new Error(`Timed out waiting for ${label}\n${stderr()}`))
    }, WAIT_TIMEOUT_MS)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolvePromise(value)
      },
      (error) => {
        clearTimeout(timer)
        rejectPromise(error)
      }
    )
  })
}

function pollUntil(readValue, label, stderr) {
  const deadline = Date.now() + WAIT_TIMEOUT_MS
  return new Promise((resolveValue, rejectValue) => {
    const poll = async () => {
      try {
        const value = await readValue()
        if (value !== undefined) {
          resolveValue(value)
          return
        }
      } catch {}
      if (Date.now() >= deadline) {
        rejectValue(new Error(`Timed out waiting for ${label}\n${stderr()}`))
        return
      }
      setTimeout(poll, 10)
    }
    void poll()
  })
}

function waitForExit(proc) {
  if (proc.exitCode !== null || proc.signalCode !== null) {
    return Promise.resolve()
  }
  return new Promise((resolveExit) => proc.once('exit', resolveExit))
}

async function loadProtocol(bundleDir) {
  const outfile = join(bundleDir, 'relay-protocol.cjs')
  await build({
    entryPoints: [resolve('src/relay/protocol.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile,
    logLevel: 'silent'
  })
  return require(outfile)
}

function createRelayClient(entryPath, args, env, protocol) {
  const proc = spawn(process.execPath, [entryPath, ...args], {
    cwd: dirname(entryPath),
    env,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const messages = []
  let stderr = ''
  let nextSequence = 1
  let stdoutBuffer = Buffer.alloc(0)
  let ready = false
  let resolveReady
  const sentinelReceived = new Promise((resolvePromise) => {
    resolveReady = resolvePromise
  })
  const decoder = new protocol.FrameDecoder((frame) => {
    if (frame.type === protocol.MessageType.Regular) {
      messages.push(protocol.parseJsonRpcMessage(frame.payload))
    }
  })
  proc.stderr.on('data', (chunk) => {
    stderr = `${stderr}${String(chunk)}`.slice(-8_000)
  })
  proc.stdout.on('data', (chunk) => {
    if (ready) {
      decoder.feed(chunk)
      return
    }
    stdoutBuffer = Buffer.concat([stdoutBuffer, chunk])
    const sentinel = Buffer.from(protocol.RELAY_SENTINEL)
    const index = stdoutBuffer.indexOf(sentinel)
    if (index < 0) {
      return
    }
    ready = true
    resolveReady()
    const remainder = stdoutBuffer.subarray(index + sentinel.length)
    if (remainder.length > 0) {
      decoder.feed(remainder)
    }
  })

  const waitForMessage = (startIndex, predicate, label) =>
    pollUntil(
      () => messages.slice(startIndex).find(predicate),
      label,
      () => stderr
    )

  const request = async (method, params = {}) => {
    const id = nextSequence++
    const startIndex = messages.length
    proc.stdin.write(protocol.encodeJsonRpcFrame({ jsonrpc: '2.0', id, method, params }, id, 0))
    const response = await waitForMessage(
      startIndex,
      (message) => message.id === id,
      `response to ${method}`
    )
    if (response.error) {
      throw new Error(`${method} failed: ${response.error.message}`)
    }
    return response.result
  }

  const notify = (method, params = {}) => {
    const sequence = nextSequence++
    proc.stdin.write(protocol.encodeJsonRpcFrame({ jsonrpc: '2.0', method, params }, sequence, 0))
  }

  return {
    proc,
    request,
    notify,
    sentinelReceived: withTimeout(sentinelReceived, 'relay sentinel', () => stderr),
    messageCount: () => messages.length,
    waitForNotification: (startIndex, method, predicate = () => true) =>
      waitForMessage(
        startIndex,
        (message) => message.method === method && predicate(message.params ?? {}),
        `${method} notification`
      ),
    stderr: () => stderr
  }
}

async function waitForWatcherPid(pidFile, previousPid, stderr) {
  return pollUntil(
    async () => {
      const pid = Number((await readFile(pidFile, 'utf8')).trim())
      if (!Number.isInteger(pid) || pid <= 0 || pid === previousPid) {
        return undefined
      }
      // Why: replacement children reuse this exclusive path after fault injection.
      await rm(pidFile, { force: true })
      return pid
    },
    previousPid ? 'replacement watcher child pid' : 'initial watcher child pid',
    stderr
  )
}

function includesWatchPath(params, targetPath) {
  return Array.isArray(params.events)
    ? params.events.some((event) => event.absolutePath === targetPath)
    : false
}

async function main() {
  const platform = `${process.platform}-${process.arch}`
  const relayEntry = resolve('out', 'relay', platform, 'relay.js')
  const watcherEntry = resolve('out', 'relay', platform, 'relay-watcher.js')
  if (!existsSync(relayEntry) || !existsSync(watcherEntry)) {
    throw new Error(`Missing built relay artifacts for ${platform}; run pnpm run build:relay first`)
  }

  let tempRoot
  let relay
  try {
    tempRoot = await mkdtemp(join(tmpdir(), 'orca-relay-watcher-fault-'))
    const watchRoot = await realpath(tempRoot)
    const pidFile = join(tempRoot, 'watcher.pid')
    const protocol = await loadProtocol(tempRoot)
    const socketPath =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\orca-relay-watcher-fault-${process.pid}-${Date.now()}`
        : join(tempRoot, 'relay.sock')
    relay = createRelayClient(
      relayEntry,
      ['--sock-path', socketPath, '--endpoint-dir', join(tempRoot, 'agent-hooks')],
      { ...process.env, ORCA_WATCHER_CHILD_PID_FILE: pidFile },
      protocol
    )
    await relay.sentinelReceived

    const spawned = await relay.request('pty.spawn', { cols: 80, rows: 24, cwd: watchRoot })
    const beforePtyMarker = `ORCA_PTY_BEFORE_${Date.now()}`
    let startIndex = relay.messageCount()
    relay.notify('pty.data', { id: spawned.id, data: `echo ${beforePtyMarker}\r` })
    await relay.waitForNotification(
      startIndex,
      'pty.data',
      (params) => params.id === spawned.id && String(params.data).includes(beforePtyMarker)
    )

    await relay.request('fs.watch', { rootPath: watchRoot })
    const firstWatcherPid = await waitForWatcherPid(pidFile, undefined, relay.stderr)
    const beforePath = join(watchRoot, 'before.txt')
    startIndex = relay.messageCount()
    await writeFile(beforePath, 'before')
    await relay.waitForNotification(startIndex, 'fs.changed', (params) =>
      includesWatchPath(params, beforePath)
    )

    const faultSignal = process.platform === 'win32' ? 'SIGTERM' : 'SIGSEGV'
    startIndex = relay.messageCount()
    process.kill(firstWatcherPid, faultSignal)
    const replacementWatcherPid = await waitForWatcherPid(pidFile, firstWatcherPid, relay.stderr)
    await relay.waitForNotification(startIndex, 'fs.changed', (params) =>
      Array.isArray(params.events)
        ? params.events.some(
            (event) => event.kind === 'overflow' && event.absolutePath === watchRoot
          )
        : false
    )

    const status = await relay.request('relay.status')
    if (status.pid !== relay.proc.pid) {
      throw new Error('relay.status did not come from the original surviving relay process')
    }
    const afterPtyMarker = `ORCA_PTY_AFTER_${Date.now()}`
    startIndex = relay.messageCount()
    relay.notify('pty.data', { id: spawned.id, data: `echo ${afterPtyMarker}\r` })
    await relay.waitForNotification(
      startIndex,
      'pty.data',
      (params) => params.id === spawned.id && String(params.data).includes(afterPtyMarker)
    )

    const afterPath = join(watchRoot, 'after.txt')
    startIndex = relay.messageCount()
    await writeFile(afterPath, 'after')
    await relay.waitForNotification(startIndex, 'fs.changed', (params) =>
      includesWatchPath(params, afterPath)
    )

    relay.notify('fs.unwatch', { rootPath: watchRoot })
    await relay.request('pty.shutdown', { id: spawned.id })
    console.log(
      JSON.stringify({
        relayPid: relay.proc.pid,
        killedWatcherPid: firstWatcherPid,
        replacementWatcherPid,
        faultSignal,
        relaySurvived: true,
        existingPtySurvived: true,
        overflowRefreshDelivered: true,
        postCrashEventDelivered: true
      })
    )
  } finally {
    if (relay && relay.proc.exitCode === null && relay.proc.signalCode === null) {
      relay.proc.kill('SIGTERM')
      try {
        await withTimeout(waitForExit(relay.proc), 'relay shutdown', relay.stderr)
      } catch {
        relay.proc.kill('SIGKILL')
        await withTimeout(waitForExit(relay.proc), 'forced relay shutdown', relay.stderr)
      }
    }
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true })
    }
  }
}

await main()
