#!/usr/bin/env node
// DAP test double for the debugger tests; stdio by default, `--tcp <port>` (0 = ephemeral) serves
// every connection as its own session and prints js-debug's listening line.
// Flags:
//   --launch-reply-after-config-done  debugpy order: `initialized` after launch, launch answered after configurationDone
//   --js-debug-children  the root sends a startDebugging reverse request after its configurationDone; the next
//                        TCP connection is the child that runs the program; setBreakpoints answers provisional
//   --frame-zero         innermost frame id is 0
//   --grandchild-holds-stderr  spawns a sleeping grandchild (ignores SIGTERM) that inherits stderr
//   --ignore-sigterm     the adapter itself ignores SIGTERM
//   --malformed-frame / --oversized-frame  answer initialize with a frame without Content-Length / over 64 MiB
//   --silent             never answer initialize
//   --stop-on-entry      stop with reason 'entry' instead of running to the first breakpoint
//   --split-writes / --coalesce  write each frame in small delayed pieces / batch a tick's frames into one write
//   --listen-delay <ms>, --stdout-flood <bytes>  print the listening line, then flood/sleep before listening
//   --announce-host <host>  print this host in the listening line
//   --socket <path>      like --tcp, on a unix socket; prints js-debug's path-form listening line
//   --ignore-stop        never answer terminate or disconnect
// Custom requests: fake/received (every message got, with its connection), fake/env, fake/pids,
// fake/burst {count}, fake/reverse {command, arguments} (answers with the client's response), fake/crash,
// fake/drop (writes a stderr line, then closes only this connection), fake/print {bytes}.

import { spawn } from 'node:child_process'
import { createServer } from 'node:net'

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const option = (name, fallback) => {
  const index = args.indexOf(name)
  return index === -1 ? fallback : args[index + 1]
}

const debugpyOrder = flag('--launch-reply-after-config-done')
const jsDebugChildren = flag('--js-debug-children')
const frameBase = flag('--frame-zero') ? 0 : 1000
const received = []
let grandchildPid = null

if (flag('--ignore-sigterm')) {
  process.on('SIGTERM', () => {})
  // Stays up once stdin closes too, so only a SIGKILL ends it.
  setInterval(() => {}, 1 << 30)
}
// Resolves once the grandchild has installed its SIGTERM handler, so a test sees it immune.
let grandchildReady = Promise.resolve()
if (flag('--grandchild-holds-stderr')) {
  const grandchild = spawn(
    process.execPath,
    [
      '-e',
      "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1 << 30)"
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] }
  )
  grandchildPid = grandchild.pid
  grandchildReady = new Promise((resolve) => grandchild.stdout.once('data', resolve))
}

const CAPABILITIES = {
  supportsConfigurationDoneRequest: true,
  supportsConditionalBreakpoints: true,
  supportsHitConditionalBreakpoints: true,
  supportsLogPoints: true,
  supportsEvaluateForHovers: true,
  supportsSetVariable: true,
  supportsRestartRequest: false,
  supportsTerminateRequest: true,
  exceptionBreakpointFilters: [
    { filter: 'raised', label: 'Raised Exceptions', default: false },
    { filter: 'uncaught', label: 'Uncaught Exceptions', default: true }
  ]
}

function createWriter(rawWrite) {
  if (flag('--split-writes')) {
    const queue = []
    let pumping = false
    const pump = () => {
      const piece = queue.shift()
      if (!piece) {
        pumping = false
        return
      }
      rawWrite(piece)
      setTimeout(pump, 1)
    }
    return (bytes) => {
      for (let offset = 0; offset < bytes.length; offset += 7) {
        queue.push(bytes.subarray(offset, offset + 7))
      }
      if (!pumping) {
        pumping = true
        setTimeout(pump, 1)
      }
    }
  }
  if (flag('--coalesce')) {
    let batch = []
    return (bytes) => {
      if (batch.length === 0) {
        setImmediate(() => {
          rawWrite(Buffer.concat(batch))
          batch = []
        })
      }
      batch.push(bytes)
    }
  }
  return rawWrite
}

function createSession(connection, rawWrite, endConnection) {
  const write = createWriter(rawWrite)
  const pendingReverse = new Map()
  const breakpoints = []
  let seq = 1
  let buffer = Buffer.alloc(0)
  let pendingLaunch = null
  let stopLine = null
  let programPath = '/fake/program.js'
  const isChild = jsDebugChildren && connection > 0

  const send = (message) => {
    const body = Buffer.from(JSON.stringify({ seq: seq++, ...message }), 'utf8')
    write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]))
  }
  const respond = (request, body, extra = {}) =>
    send({
      type: 'response',
      request_seq: request.seq,
      command: request.command,
      success: true,
      ...(body === undefined ? {} : { body }),
      ...extra
    })
  const refuse = (request, message) => respond(request, undefined, { success: false, message })
  const event = (name, body) => send({ type: 'event', event: name, ...(body ? { body } : {}) })
  const reverse = (command, reverseArgs) =>
    new Promise((resolve) => {
      const requestSeq = seq
      pendingReverse.set(requestSeq, resolve)
      send({ type: 'request', command, arguments: reverseArgs })
    })

  const stopAt = (line, reason, extra = {}) => {
    stopLine = line
    event('stopped', {
      reason,
      threadId: 1,
      allThreadsStopped: true,
      ...extra
    })
  }
  const finish = () => {
    event('output', { category: 'stdout', output: 'fake program finished\n' })
    event('terminated')
    event('exited', { exitCode: 0 })
  }
  const runFrom = (afterLine) => {
    const next = breakpoints.filter((bp) => bp.line > afterLine).sort((a, b) => a.line - b.line)[0]
    if (next) {
      stopAt(next.line, 'breakpoint', { hitBreakpointIds: [next.id] })
    } else {
      finish()
    }
  }
  const runProgram = () => {
    event('output', { category: 'stdout', output: 'fake program started\n' })
    event('thread', { reason: 'started', threadId: 1 })
    if (flag('--stop-on-entry')) {
      stopAt(1, 'entry')
    } else {
      runFrom(0)
    }
  }
  const startDebuggingChild = () =>
    reverse('startDebugging', {
      request: 'launch',
      configuration: {
        type: 'pwa-node',
        name: 'fake child',
        __pendingTargetId: 'fake-target-1'
      }
    })

  const handle = async (request) => {
    const a = request.arguments ?? {}
    switch (request.command) {
      case 'initialize':
        if (flag('--silent')) {
          return
        }
        if (flag('--malformed-frame')) {
          rawWrite(Buffer.from('Content-Type: application/json\r\n\r\n{}'))
          return
        }
        if (flag('--oversized-frame')) {
          rawWrite(Buffer.from(`Content-Length: ${64 * 1024 * 1024 + 1}\r\n\r\n`))
          return
        }
        respond(request, CAPABILITIES)
        if (!debugpyOrder) {
          event('initialized')
        }
        return
      case 'launch':
      case 'attach':
        programPath = a.program ?? programPath
        if (debugpyOrder) {
          pendingLaunch = request
          event('initialized')
        } else {
          respond(request)
        }
        return
      case 'setBreakpoints': {
        const lines = (a.breakpoints ?? []).map((bp) => bp.line)
        breakpoints.length = 0
        lines.forEach((line, index) => breakpoints.push({ id: index + 1, line }))
        const provisional = jsDebugChildren
        respond(request, {
          breakpoints: breakpoints.map((bp) =>
            provisional
              ? {
                  id: bp.id,
                  verified: false,
                  message: 'breakpoint.provisionalBreakpoint'
                }
              : { id: bp.id, verified: true, line: bp.line, source: a.source }
          )
        })
        return
      }
      case 'setExceptionBreakpoints':
        respond(request, { breakpoints: [] })
        return
      case 'configurationDone':
        respond(request)
        if (pendingLaunch) {
          respond(pendingLaunch)
          pendingLaunch = null
        }
        if (jsDebugChildren && !isChild) {
          void startDebuggingChild()
        } else {
          runProgram()
        }
        return
      case 'threads':
        respond(request, { threads: [{ id: 1, name: 'main' }] })
        return
      case 'stackTrace': {
        const source = {
          name: programPath.split(/[\\/]/).pop(),
          path: programPath
        }
        respond(request, {
          stackFrames: [
            {
              id: frameBase,
              name: 'inner',
              source,
              line: stopLine ?? 1,
              column: 1
            },
            { id: frameBase + 1, name: 'main', source, line: 1, column: 1 }
          ],
          totalFrames: 2
        })
        return
      }
      case 'scopes':
        respond(request, {
          scopes: [
            {
              name: 'Locals',
              variablesReference: 100 + a.frameId,
              expensive: false
            }
          ]
        })
        return
      case 'variables':
        respond(request, {
          variables:
            a.variablesReference === 900
              ? [{ name: 'x', value: '42', type: 'int', variablesReference: 0 }]
              : [
                  { name: 'a', value: '1', type: 'int', variablesReference: 0 },
                  {
                    name: 'obj',
                    value: '{x}',
                    type: 'object',
                    variablesReference: 900
                  }
                ]
        })
        return
      case 'evaluate':
        respond(request, {
          result: `${a.expression}@${a.frameId === undefined ? 'global' : a.frameId}`,
          variablesReference: 0
        })
        return
      case 'continue':
        respond(request, { allThreadsContinued: true })
        event('continued', { threadId: 1, allThreadsContinued: true })
        runFrom(stopLine ?? 0)
        return
      case 'next':
      case 'stepIn':
      case 'stepOut':
        respond(request)
        stopAt((stopLine ?? 0) + 1, 'step')
        return
      case 'pause':
        respond(request)
        stopAt(stopLine ?? 1, 'pause')
        return
      case 'disconnect':
      case 'terminate':
        if (flag('--ignore-stop')) {
          return
        }
        respond(request)
        event('terminated')
        setTimeout(endConnection, 20)
        return
      case 'fake/received':
        respond(request, { messages: received.slice(0, -1) })
        return
      case 'fake/env':
        respond(request, { env: process.env, cwd: process.cwd() })
        return
      case 'fake/pids':
        await grandchildReady
        respond(request, { pid: process.pid, grandchildPid })
        return
      case 'fake/burst':
        for (let index = 0; index < (a.count ?? 1); index++) {
          event('output', { category: 'console', output: `burst ${index}\n` })
        }
        respond(request, { count: a.count ?? 1 })
        return
      case 'fake/reverse':
        respond(request, { response: await reverse(a.command, a.arguments) })
        return
      case 'fake/print':
        event('output', { category: 'stdout', output: 'p'.repeat(a.bytes ?? 1) })
        respond(request)
        return
      case 'fake/drop':
        respond(request)
        process.stderr.write('fake child dropped: socket gone\n')
        setTimeout(endConnection, 100)
        return
      case 'fake/crash':
        respond(request)
        process.stderr.write('fake adapter crashed: boom\n')
        setTimeout(() => process.exit(3), 20)
        return
      default:
        refuse(request, `unknown command ${request.command}`)
    }
  }

  const onMessage = (message) => {
    received.push({ connection, message })
    if (message.type === 'response') {
      pendingReverse.get(message.request_seq)?.(message)
      pendingReverse.delete(message.request_seq)
    } else if (message.type === 'request') {
      void handle(message)
    }
  }

  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    for (;;) {
      const headerEnd = buffer.indexOf('\r\n\r\n')
      if (headerEnd === -1) {
        return
      }
      const length = Number(/Content-Length: *(\d+)/i.exec(buffer.subarray(0, headerEnd))?.[1])
      const bodyStart = headerEnd + 4
      if (buffer.length < bodyStart + length) {
        return
      }
      const body = buffer.subarray(bodyStart, bodyStart + length).toString('utf8')
      buffer = buffer.subarray(bodyStart + length)
      onMessage(JSON.parse(body))
    }
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function reservePort() {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

function createSessionServer() {
  let nextConnection = 0
  return createServer((socket) => {
    const onData = createSession(
      nextConnection++,
      (bytes) => socket.write(bytes),
      () => (jsDebugChildren ? socket.end() : process.exit(0))
    )
    socket.on('data', onData)
    socket.on('error', () => {})
  })
}

async function serveSocket(path) {
  const server = createSessionServer()
  await new Promise((resolve) => server.listen(path, resolve))
  process.stdout.write(`Debug server listening at ${path}\n`)
}

async function serveTcp(requestedPort) {
  const server = createSessionServer()
  const listen = (port) =>
    new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server.address().port)))
  const floodBytes = Number(option('--stdout-flood', 0))
  const listenDelayMs = Number(option('--listen-delay', 0))
  // The double may race for its port; the transport under test must not.
  const deferred = floodBytes > 0 || listenDelayMs > 0
  let port = requestedPort
  if (deferred && port === 0) {
    port = await reservePort()
  } else if (!deferred) {
    port = await listen(port)
  }
  process.stdout.write(
    `Debug server listening at ${option('--announce-host', '127.0.0.1')}:${port}\n`
  )
  if (floodBytes > 0) {
    await new Promise((resolve) => process.stdout.write(Buffer.alloc(floodBytes, 46), resolve))
  }
  await sleep(listenDelayMs)
  if (deferred) {
    await listen(port)
  }
}

if (flag('--socket')) {
  void serveSocket(option('--socket', ''))
} else if (flag('--tcp')) {
  void serveTcp(Number(option('--tcp', 0)))
} else {
  const onData = createSession(
    0,
    (bytes) => process.stdout.write(bytes),
    () => process.exit(0)
  )
  process.stdin.on('data', onData)
}
