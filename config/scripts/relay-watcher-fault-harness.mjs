import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const WAIT_TIMEOUT_MS = 20_000
const require = createRequire(import.meta.url)

// Why: endpoint credentials are 32–256 base64url chars; openClient requires an authenticated
// transport, and #12746 admits pty.data only after a consumer grant.
function writeEndpointCredential(path) {
  return writeFile(path, randomBytes(32).toString('base64url'), 'utf8')
}

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

function attachProcessStreams(proc) {
  let stderr = ''
  proc.stderr.on('data', (chunk) => {
    stderr = `${stderr}${String(chunk)}`.slice(-8_000)
  })
  return {
    stderr: () => stderr
  }
}

function waitForStdoutSentinel(proc, protocol, stderr) {
  let stdoutBuffer = Buffer.alloc(0)
  return withTimeout(
    new Promise((resolvePromise, rejectPromise) => {
      let settled = false
      const onData = (chunk) => {
        stdoutBuffer = Buffer.concat([stdoutBuffer, chunk])
        const sentinel = Buffer.from(protocol.RELAY_SENTINEL)
        const index = stdoutBuffer.indexOf(sentinel)
        if (index < 0) {
          return
        }
        settled = true
        proc.stdout.off('data', onData)
        proc.off('exit', onExit)
        resolvePromise(stdoutBuffer.subarray(index + sentinel.length))
      }
      const onExit = (code, signal) => {
        if (settled) {
          return
        }
        settled = true
        proc.stdout.off('data', onData)
        rejectPromise(
          new Error(
            `process exited before sentinel (code=${code}, signal=${signal})\n${stderr()}`
          )
        )
      }
      proc.stdout.on('data', onData)
      proc.once('exit', onExit)
    }),
    'relay sentinel',
    stderr
  )
}

function createRelayClient(entryPath, args, env, protocol) {
  const proc = spawn(process.execPath, [entryPath, ...args], {
    cwd: dirname(entryPath),
    env,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const streams = attachProcessStreams(proc)
  const messages = []
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
      streams.stderr
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
    sentinelReceived: withTimeout(sentinelReceived, 'relay sentinel', streams.stderr),
    messageCount: () => messages.length,
    waitForNotification: (startIndex, method, predicate = () => true) =>
      waitForMessage(
        startIndex,
        (message) => message.method === method && predicate(message.params ?? {}),
        `${method} notification`
      ),
    stderr: streams.stderr
  }
}

async function stopProcess(proc, stderr, label) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) {
    return
  }
  proc.kill('SIGTERM')
  try {
    await withTimeout(waitForExit(proc), `${label} shutdown`, stderr)
  } catch {
    proc.kill('SIGKILL')
    await withTimeout(waitForExit(proc), `forced ${label} shutdown`, stderr)
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
  let daemon
  let daemonStreams
  let relay
  try {
    tempRoot = await mkdtemp(join(tmpdir(), 'orca-relay-watcher-fault-'))
    const watchRoot = await realpath(tempRoot)
    const pidFile = join(tempRoot, 'watcher.pid')
    const credentialFile = join(tempRoot, 'endpoint.credential')
    const protocol = await loadProtocol(tempRoot)
    const socketPath =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\orca-relay-watcher-fault-${process.pid}-${Date.now()}`
        : join(tempRoot, 'relay.sock')
    await writeEndpointCredential(credentialFile)

    // Why detached + --connect: the daemon primary stdio is unproved, so it cannot open a consumer
    // session; only an endpoint-credential socket client is admitted for pty.data after #12746.
    daemon = spawn(
      process.execPath,
      [
        relayEntry,
        '--detached',
        '--grace-time',
        '0',
        '--sock-path',
        socketPath,
        '--endpoint-dir',
        join(tempRoot, 'agent-hooks'),
        '--credential-file',
        credentialFile
      ],
      {
        cwd: dirname(relayEntry),
        env: { ...process.env, ORCA_WATCHER_CHILD_PID_FILE: pidFile },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    daemonStreams = attachProcessStreams(daemon)
    await waitForStdoutSentinel(daemon, protocol, daemonStreams.stderr)

    relay = createRelayClient(
      relayEntry,
      ['--connect', '--sock-path', socketPath, '--credential-file', credentialFile],
      process.env,
      protocol
    )
    await relay.sentinelReceived

    // Why no outputFlowControl: legacy owner grant admits plain pty.data without delivery tokens.
    const grant = await relay.request('pty.openClient', {
      protocolVersion: 1,
      clientInstanceId: `relay-watcher-fault-${process.pid}`,
      requestedRole: 'session-owner'
    })
    if (grant?.role !== 'session-owner') {
      throw new Error(`expected session-owner grant, got ${JSON.stringify(grant)}`)
    }

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
    const firstWatcherPid = await waitForWatcherPid(pidFile, undefined, () =>
      `${daemonStreams.stderr()}\n${relay.stderr()}`
    )
    const beforePath = join(watchRoot, 'before.txt')
    startIndex = relay.messageCount()
    await writeFile(beforePath, 'before')
    await relay.waitForNotification(startIndex, 'fs.changed', (params) =>
      includesWatchPath(params, beforePath)
    )

    const faultSignal = process.platform === 'win32' ? 'SIGTERM' : 'SIGSEGV'
    startIndex = relay.messageCount()
    process.kill(firstWatcherPid, faultSignal)
    const replacementWatcherPid = await waitForWatcherPid(pidFile, firstWatcherPid, () =>
      `${daemonStreams.stderr()}\n${relay.stderr()}`
    )
    await relay.waitForNotification(startIndex, 'fs.changed', (params) =>
      Array.isArray(params.events)
        ? params.events.some(
            (event) => event.kind === 'overflow' && event.absolutePath === watchRoot
          )
        : false
    )

    const status = await relay.request('relay.status')
    if (status.pid !== daemon.pid) {
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
        relayPid: daemon.pid,
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
    await stopProcess(relay?.proc, relay?.stderr ?? (() => ''), 'connect bridge')
    await stopProcess(daemon, daemonStreams?.stderr ?? (() => ''), 'relay daemon')
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true })
    }
  }
}

await main()
