import { createHash } from 'node:crypto'
import { errorMonitor } from 'node:events'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { redactTranscript } from './pty-transcript-secret-scan.mjs'

const MAX_RECORDS = 32
const MAX_EVENTS = 256
const ESC = String.fromCharCode(27)
const CONTROL_SEQUENCE = new RegExp(`${ESC}(?:\\[[0-?]*[ -/]*[@-~]|[@-_])`, 'g')

export function sanitizeStressText(text) {
  const source = String(text ?? '')
  const controls = []
  let sourceCursor = 0
  let scanIndex = 0
  const scanText = source.replace(CONTROL_SEQUENCE, (sequence, index) => {
    scanIndex += index - sourceCursor
    sourceCursor = index + sequence.length
    // OSC framing keeps title payloads separate from the adjacent rendered text.
    if (sequence === `${ESC}]` || sequence === `${ESC}\\`) {
      scanIndex += sequence.length
      return sequence
    }
    controls.push({ sequence, index: scanIndex })
    return ''
  })
  const firstPass = redactTranscript(scanText).text
  // A local identity can mask a wider email finding in the first pass.
  const sanitized = redactTranscript(firstPass).text
  let result = ''
  let cursor = 0
  for (const { sequence, index } of controls) {
    result += sanitized.slice(cursor, index) + sequence
    cursor = index
  }
  return result + sanitized.slice(cursor)
}

export function loadedStressInputHashes(addonPath, resolveModule) {
  const files = [
    ['conpty.node', addonPath],
    ['conpty.dll', join(dirname(addonPath), 'conpty', 'conpty.dll')],
    ['OpenConsole.exe', join(dirname(addonPath), 'conpty', 'OpenConsole.exe')]
  ]
  const modules = [
    'utils.js',
    'windowsTerminal.js',
    'windowsPtyAgent.js',
    'windowsConoutConnection.js',
    'worker/conoutSocketWorker.js'
  ]
  return [...files, ...modules.map((name) => [name])].map(([name, path]) => {
    try {
      const bytes = readFileSync(path ?? resolveModule(`node-pty/lib/${name}`))
      return { name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
    } catch (error) {
      return { name, unavailable: error.code ?? 'unknown' }
    }
  })
}

function socketState(socket) {
  if (!socket) {
    return null
  }
  return {
    connecting: socket.connecting === true,
    destroyed: socket.destroyed === true,
    readable: socket.readable === true,
    writable: socket.writable === true
  }
}

export function createStressObserver(report) {
  const started = performance.now()
  const records = []
  let events = 0
  let omittedEvents = 0
  let omittedRecords = 0

  function state(record, context) {
    const { proc } = record
    const agent = proc._agent
    return {
      ...context,
      shellPid: proc.pid,
      ptyId: proc._pty,
      terminalReady: proc._isReady === true,
      exitCallbackObserved: record.exited === true,
      closeRequested: record.closed === true,
      nativeExitCode: Number.isInteger(agent?.exitCode) ? agent.exitCode : null,
      deferredOperations: Array.isArray(proc._deferreds) ? proc._deferreds.length : null,
      inputSocket: socketState(agent?._inSocket),
      outputSocket: socketState(proc._socket),
      conoutWorkerThreadId: agent?._conoutSocketWorker?._worker?.threadId ?? null
    }
  }

  function emit(phase, details) {
    if (events >= MAX_EVENTS) {
      omittedEvents += 1
      return
    }
    events += 1
    report(phase, { elapsedMs: Math.round(performance.now() - started), ...details })
  }

  function watch(record, context) {
    if (records.length >= MAX_RECORDS) {
      // Keep the warmup survivor alongside the newest terminals.
      const oldestRecent = records[0].context.round === -1 && records[0].context.slot === -1 ? 1 : 0
      records.splice(oldestRecent, 1)
      omittedRecords += 1
    }
    records.push({ record, context })
    const { proc } = record
    const snapshot = () => state(record, context)
    emit('spawn-returned', snapshot())
    let firstData = true
    proc.onData((chunk) => {
      if (firstData) {
        firstData = false
        emit('first-data', { ...snapshot(), bytes: Buffer.byteLength(chunk) })
      }
    })
    proc.onExit((event) => emit('pty-exit-callback', { ...snapshot(), exitCode: event.exitCode }))
    for (const [name, socket] of [
      ['input', proc._agent?._inSocket],
      ['output', proc._socket]
    ]) {
      if (socket) {
        socket.on(errorMonitor, (error) =>
          emit('pipe-error', {
            ...snapshot(),
            pipe: name,
            code: error.code ?? null,
            message: sanitizeStressText(String(error.message))
          })
        )
        for (const event of ['connect', 'ready_datapipe', 'end', 'close']) {
          socket.on(event, () => emit(`pipe-${event}`, { ...snapshot(), pipe: name }))
        }
      }
    }
    const worker = proc._agent?._conoutSocketWorker?._worker
    if (worker) {
      worker.on('online', () => emit('conout-worker-online', snapshot()))
      worker.on('message', (message) => {
        if (message === 1) {
          emit('conout-worker-ready', snapshot())
        }
      })
      worker.on('exit', (code) => emit('conout-worker-exit', { ...snapshot(), code }))
      worker.on(errorMonitor, (error) =>
        emit('conout-worker-error', { ...snapshot(), message: sanitizeStressText(error.message) })
      )
    }
    const agent = proc._agent
    if (typeof agent?._$onProcessExit === 'function') {
      const original = agent._$onProcessExit
      // Observe the existing callback without changing its receiver, arguments, or result.
      agent._$onProcessExit = function (...args) {
        emit('native-exit-callback', { ...snapshot(), exitCode: args[0] })
        return original.call(this, ...args)
      }
    }
  }

  function pending(phase) {
    report(phase, {
      elapsedMs: Math.round(performance.now() - started),
      observerEvents: events,
      omittedEvents,
      omittedRecords,
      records: records.map(({ record, context }) => ({
        ...state(record, context),
        output: sanitizeStressText(record.output.slice(-2048))
      }))
    })
  }

  function checkpoint(phase, record) {
    const entry = records.find((entry) => entry.record === record)
    if (entry) {
      emit(phase, state(entry.record, entry.context))
    }
  }

  return { watch, pending, checkpoint }
}
