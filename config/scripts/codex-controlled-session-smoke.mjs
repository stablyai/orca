import { execFile, spawn } from 'node:child_process'
import { chmod, mkdtemp, rm, stat } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import WebSocket from 'ws'

const execFileAsync = promisify(execFile)

if (process.env.ORCA_RUN_CODEX_CONTROLLED_SESSION_SMOKE !== '1') {
  console.log('SKIPPED: set ORCA_RUN_CODEX_CONTROLLED_SESSION_SMOKE=1 to run the disposable smoke')
  process.exit(0)
}

const threadId = process.argv[2]?.trim()
if (!threadId || process.platform === 'win32') {
  throw new Error(
    'usage: ORCA_RUN_CODEX_CONTROLLED_SESSION_SMOKE=1 node ... <thread-id> (Unix only)'
  )
}
await assertPinnedCodexVersion()

if (threadId === '--fresh') {
  await runFreshSmoke()
  process.exit(0)
}

const socketRoot = await mkdtemp('/tmp/ocw-smoke-')
const socketPath = join(socketRoot, 'app.sock')
await chmod(socketRoot, 0o700)

const child = spawn('codex', ['app-server', '--listen', `unix://${socketPath}`], {
  stdio: ['ignore', 'ignore', 'ignore'],
  env: process.env
})
let childError
child.on('error', (error) => {
  childError = error
})

let socket
try {
  await waitForSocket(socketPath, child, () => childError)
  await chmod(socketPath, 0o600)
  socket = new WebSocket('ws://localhost/rpc', {
    perMessageDeflate: false,
    createConnection: () => createConnection(socketPath)
  })
  await onceOpen(socket)
  let requestId = 0
  const request = (method, params) => rpc(socket, ++requestId, method, params)
  const initialized = await request('initialize', {
    clientInfo: { name: 'orca_smoke', title: 'Orca smoke', version: '0.0.0' },
    capabilities: { experimentalApi: true, requestAttestation: false }
  })
  socket.send(JSON.stringify({ method: 'initialized' }))
  const read = await request('thread/read', { threadId, includeTurns: false })
  if (initialized?.platformFamily !== 'unix' || read?.thread?.id !== threadId) {
    throw new Error('live smoke identity check failed')
  }
  console.log(
    'PASS: private Unix transport initialized and read the requested thread; no turn started'
  )
} finally {
  socket?.terminate()
  await stopChild(child)
  await rm(socketRoot, { recursive: true, force: true })
}

async function waitForSocket(path, server, getSpawnError) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const spawnError = getSpawnError()
    if (spawnError) {
      throw spawnError
    }
    if (server.exitCode !== null) {
      throw new Error('Codex app-server exited before smoke readiness')
    }
    try {
      if ((await stat(path)).isSocket()) {
        return
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('Codex app-server smoke socket timed out')
}

function onceOpen(webSocket, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer)
      webSocket.off('open', onOpen)
      webSocket.off('error', onError)
    }
    const onOpen = () => {
      cleanup()
      resolve()
    }
    const onError = (error) => {
      cleanup()
      reject(error)
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('Codex app-server socket connect timed out'))
    }, timeoutMs)
    timer.unref?.()
    webSocket.once('open', onOpen)
    webSocket.once('error', onError)
  })
}

function rpc(webSocket, id, method, params, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer)
      webSocket.off('message', onMessage)
    }
    const onMessage = (raw) => {
      let message
      try {
        message = JSON.parse(raw.toString())
      } catch (error) {
        cleanup()
        reject(error)
        return
      }
      if (message.id !== id) {
        return
      }
      cleanup()
      if (message.error) {
        reject(new Error(message.error.message ?? `${method} failed`))
      } else {
        resolve(message.result)
      }
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`Codex app-server ${method} timed out`))
    }, timeoutMs)
    timer.unref?.()
    webSocket.on('message', onMessage)
    webSocket.send(JSON.stringify({ id, method, params }), (error) => {
      if (error) {
        cleanup()
        reject(error)
      }
    })
  })
}

async function runFreshSmoke() {
  if (process.argv.length !== 3) {
    throw new Error('usage: ORCA_RUN_CODEX_CONTROLLED_SESSION_SMOKE=1 node ... --fresh')
  }
  const cwd = process.cwd()
  const expectedHome = resolve(process.env.CODEX_HOME || join(homedir(), '.codex'))
  const socketRoot = await mkdtemp('/tmp/ocw-smoke-')
  const socketPath = join(socketRoot, 'app.sock')
  await chmod(socketRoot, 0o700)
  const child = spawn('codex', ['app-server', '--listen', `unix://${socketPath}`], {
    cwd,
    stdio: ['ignore', 'ignore', 'ignore'],
    env: process.env
  })
  let childError
  child.on('error', (error) => {
    childError = error
  })
  let socket
  let terminalHandle
  let completedThreadId
  let smokeError
  try {
    await waitForSocket(socketPath, child, () => childError)
    await chmod(socketPath, 0o600)
    const socketIdentity = await stat(socketPath)
    socket = new WebSocket('ws://localhost/rpc', {
      perMessageDeflate: false,
      createConnection: () => createConnection(socketPath)
    })
    await onceOpen(socket)
    let requestId = 0
    const request = (method, params) => rpc(socket, ++requestId, method, params)
    const initialized = await request('initialize', {
      clientInfo: { name: 'orca_fresh_smoke', title: 'Orca fresh smoke', version: '0.0.0' },
      capabilities: { experimentalApi: true, requestAttestation: false }
    })
    socket.send(JSON.stringify({ method: 'initialized' }))
    assertFreshServerIdentity(initialized, expectedHome)
    const started = await request('thread/start', { cwd, experimentalRawEvents: false })
    const freshThreadId = started?.thread?.id
    if (typeof freshThreadId !== 'string' || !freshThreadId) {
      throw new Error('fresh smoke thread/start returned an invalid thread identity')
    }
    const resumeCommand = [
      'env',
      `CODEX_HOME=${expectedHome}`,
      'codex',
      'resume',
      '--remote',
      `unix://${socketPath}`,
      '--cd',
      cwd,
      freshThreadId
    ]
      .map(quotePosixShell)
      .join(' ')
    const created = await orcaJson([
      'terminal',
      'create',
      '--worktree',
      `path:${cwd}`,
      '--command',
      resumeCommand,
      '--focus'
    ])
    terminalHandle = created?.result?.terminal?.handle
    if (typeof terminalHandle !== 'string' || created.result.terminal.surface !== 'visible') {
      throw new Error('fresh smoke did not create exactly one visible terminal')
    }
    const waited = await orcaJson([
      'terminal',
      'wait',
      '--terminal',
      terminalHandle,
      '--for',
      'tui-idle',
      '--timeout-ms',
      '60000'
    ])
    if (waited?.result?.wait?.handle !== terminalHandle || waited.result.wait.satisfied !== true) {
      throw new Error('fresh smoke visible terminal did not reach tui-idle')
    }
    const currentSocket = await stat(socketPath)
    if (
      !currentSocket.isSocket() ||
      currentSocket.dev !== socketIdentity.dev ||
      currentSocket.ino !== socketIdentity.ino
    ) {
      throw new Error('fresh smoke Unix transport identity changed')
    }
    await assertFreshThreadHasZeroTurns(request, freshThreadId)
    completedThreadId = freshThreadId
  } catch (error) {
    smokeError = error
  }
  const cleanupErrors = []
  if (terminalHandle) {
    try {
      const closed = await orcaJson(['terminal', 'close', '--terminal', terminalHandle])
      if (closed?.result?.close?.handle !== terminalHandle) {
        throw new Error('fresh smoke terminal close identity mismatch')
      }
    } catch (error) {
      cleanupErrors.push(error)
    }
  }
  let serverStopped = false
  try {
    socket?.terminate()
    await stopChild(child)
    serverStopped = true
  } catch (error) {
    cleanupErrors.push(error)
  }
  if (serverStopped) {
    try {
      await rm(socketRoot, { recursive: true, force: true })
    } catch (error) {
      cleanupErrors.push(error)
    }
  }
  const errors = [...(smokeError ? [smokeError] : []), ...cleanupErrors]
  if (errors.length === 1) {
    throw errors[0]
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, 'fresh smoke and cleanup failed')
  }
  console.log(
    `PASS: fresh thread ${completedThreadId} reached visible tui-idle over the owned Unix transport with zero turns; no input injected`
  )
}

async function assertPinnedCodexVersion() {
  let stdout
  try {
    const result = await execFileAsync('codex', ['--version'], {
      cwd: process.cwd(),
      env: process.env,
      timeout: 10_000
    })
    stdout = result.stdout
  } catch {
    throw new Error('controlled Codex smoke requires bare codex-cli 0.145.0')
  }
  if (stdout.trim() !== 'codex-cli 0.145.0') {
    throw new Error('controlled Codex smoke requires bare codex-cli 0.145.0')
  }
}

async function assertFreshThreadHasZeroTurns(request, threadId) {
  try {
    const read = await request('thread/read', { threadId, includeTurns: true })
    if (
      read?.thread?.id !== threadId ||
      !Array.isArray(read.thread.turns) ||
      read.thread.turns.length !== 0
    ) {
      throw new Error('fresh smoke exact-thread or zero-turn check failed')
    }
  } catch (error) {
    const unmaterialized = `thread ${threadId} is not materialized yet; includeTurns is unavailable before first user message`
    if (!(error instanceof Error) || error.message !== unmaterialized) {
      throw error
    }
  }
}

function assertFreshServerIdentity(initialized, expectedHome) {
  if (
    initialized?.platformFamily !== 'unix' ||
    typeof initialized?.codexHome !== 'string' ||
    resolve(initialized.codexHome) !== expectedHome ||
    typeof initialized?.userAgent !== 'string' ||
    !initialized.userAgent.trim()
  ) {
    throw new Error('fresh smoke transport/home/user-agent identity check failed')
  }
}

async function orcaJson(args) {
  try {
    const { stdout } = await execFileAsync('orca', [...args, '--json'], {
      cwd: process.cwd(),
      env: process.env,
      timeout: 70_000
    })
    return JSON.parse(stdout)
  } catch (error) {
    const command = ['orca', ...args.slice(0, 2)].join(' ')
    const stdout = typeof error?.stdout === 'string' ? error.stdout : ''
    let parsed
    try {
      parsed = JSON.parse(stdout)
    } catch {}
    const detail = parsed?.error ?? parsed
    if (typeof detail?.code === 'string' && typeof detail?.message === 'string') {
      throw new Error(`${command} failed: ${detail.code}: ${detail.message}`)
    }
    throw new Error(`${command} failed without a structured error`)
  }
}

function quotePosixShell(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

async function stopChild(child) {
  if (child.exitCode !== null) {
    return
  }
  child.kill('SIGTERM')
  if (!(await waitForExit(child, 5000))) {
    child.kill('SIGKILL')
    if (!(await waitForExit(child, 5000))) {
      throw new Error('Codex app-server did not exit after SIGKILL; owned root preserved')
    }
  }
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) {
    return Promise.resolve(true)
  }
  return new Promise((resolveExit) => {
    const timer = setTimeout(() => resolveExit(false), timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolveExit(true)
    })
  })
}
