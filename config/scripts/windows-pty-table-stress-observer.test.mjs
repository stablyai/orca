import { EventEmitter, errorMonitor } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { scanTranscriptForSecrets } from './pty-transcript-secret-scan.mjs'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createStressObserver,
  loadedStressInputHashes,
  sanitizeStressText
} from './windows-pty-table-stress-observer.mjs'

const directories = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function terminal() {
  const proc = new EventEmitter()
  proc.pid = 321
  proc._pty = 12
  proc._isReady = false
  proc._deferreds = [() => {}]
  proc._socket = new EventEmitter()
  proc._agent = {
    _inSocket: new EventEmitter(),
    _conoutSocketWorker: { _worker: new EventEmitter() },
    _$onProcessExit(code) {
      this.exitCode = code
      return 'original-result'
    }
  }
  proc.onData = (listener) => proc.on('ptyData', listener)
  proc.onExit = (listener) => proc.on('ptyExit', listener)
  return { proc, exited: false, closed: false, output: '' }
}

function observation(record = terminal()) {
  const events = []
  const observer = createStressObserver((phase, details) => events.push({ phase, ...details }))
  observer.watch(record, { round: 0, slot: 1 })
  return { observer, events, record }
}

describe('Windows PTY stress observer', () => {
  it('distinguishes a silent deferred terminal, native exit, and the public exit callback', () => {
    const { observer, events, record } = observation()
    observer.pending('readiness-timeout-state')
    expect(events.at(-1).records[0]).toMatchObject({
      shellPid: 321,
      terminalReady: false,
      deferredOperations: 1,
      nativeExitCode: null,
      exitCallbackObserved: false
    })
    expect(record.proc._agent._$onProcessExit(9)).toBe('original-result')
    observer.pending('exit-drain-state')
    expect(events.at(-1).records[0]).toMatchObject({
      nativeExitCode: 9,
      exitCallbackObserved: false
    })
    record.exited = true
    record.proc.emit('ptyExit', { exitCode: 9 })
    expect(events.at(-1)).toMatchObject({ phase: 'pty-exit-callback', exitCallbackObserved: true })
  })

  it('preserves native callback receiver, arguments, return value, and thrown errors', () => {
    const record = terminal()
    const calls = []
    const failure = new Error('native callback failure')
    record.proc._agent._$onProcessExit = function (...args) {
      calls.push({ receiver: this, args })
      if (args[0] === 1) {
        throw failure
      }
      return 'unchanged'
    }
    observation(record)
    expect(record.proc._agent._$onProcessExit(0, 'extra')).toBe('unchanged')
    expect(calls).toEqual([{ receiver: record.proc._agent, args: [0, 'extra'] }])
    expect(() => record.proc._agent._$onProcessExit(1)).toThrow(failure)
    expect(calls).toHaveLength(2)
  })

  it('observes worker and socket errors without consuming an unhandled error', () => {
    const { events, record } = observation()
    const output = record.proc._socket
    expect(output.listenerCount('error')).toBe(0)
    expect(output.listenerCount(errorMonitor)).toBe(1)
    const failure = Object.assign(new Error('broken pipe'), { code: 'EPIPE' })
    expect(() => output.emit('error', failure)).toThrow(failure)
    expect(events.at(-1)).toMatchObject({ phase: 'pipe-error', pipe: 'output', code: 'EPIPE' })
    const worker = record.proc._agent._conoutSocketWorker._worker
    expect(worker.listenerCount('error')).toBe(0)
    expect(() => worker.emit('error', failure)).toThrow(failure)
    expect(events.at(-1)).toMatchObject({ phase: 'conout-worker-error' })
  })

  it('keeps first data separate from worker readiness and bounds repeated milestones', () => {
    const { observer, events, record } = observation()
    const worker = record.proc._agent._conoutSocketWorker._worker
    worker.emit('message', 1)
    expect(events.at(-1).phase).toBe('conout-worker-ready')
    expect(events.some((event) => event.phase === 'first-data')).toBe(false)
    record.proc.emit('ptyData', 'first')
    record.proc.emit('ptyData', 'second')
    expect(events.filter((event) => event.phase === 'first-data')).toHaveLength(1)
    for (let index = 0; index < 1_000; index += 1) {
      worker.emit('message', 1)
    }
    expect(events).toHaveLength(256)
    observer.pending('exit-drain-state')
    expect(events.at(-1).observerEvents).toBe(256)
    expect(events.at(-1).omittedEvents).toBeGreaterThan(0)
  })

  it('bounds tracked terminals and redacts the assembled tail without changing raw input', () => {
    const events = []
    const observer = createStressObserver((phase, details) => events.push({ phase, ...details }))
    const raw = '\u001b[31mprivate@sensitive.test\r\nBearer secret01234567890123456789'
    const first = terminal()
    first.output = raw
    observer.watch(first, { round: -1, slot: -1 })
    for (let index = 1; index < 40; index += 1) {
      observer.watch(terminal(), { round: index, slot: 1 })
    }
    observer.pending('exit-drain-state')
    const last = events.at(-1)
    expect(last.records).toHaveLength(32)
    expect(last.omittedRecords).toBe(8)
    expect(last.records[0]).toMatchObject({ round: -1, slot: -1 })
    expect(last.records.at(-1)).toMatchObject({ round: 39, slot: 1 })
    expect(last.records[0].output).not.toContain('private@sensitive.test')
    expect(last.records[0].output).not.toContain('secret01234567890123456789')
    expect(last.records[0].output.length).toBe(raw.length)
    expect(last.records[0].output).toContain('\u001b[31m')
    expect(first.output).toBe(raw)
  })

  it('hashes actual loaded files and qualifies missing runtime companions', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pty-stress-inputs-'))
    directories.push(directory)
    const addon = join(directory, 'conpty.node')
    writeFileSync(addon, 'actual-loaded-bytes')
    const hashes = loadedStressInputHashes(addon, () => addon)
    expect(hashes[0]).toMatchObject({ name: 'conpty.node', bytes: 19 })
    expect(hashes[0].sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(hashes[1]).toEqual({ name: 'conpty.dll', unavailable: 'ENOENT' })
    expect(hashes[2]).toEqual({ name: 'OpenConsole.exe', unavailable: 'ENOENT' })
    expect(hashes.slice(3).every((hash) => hash.sha256 === hashes[0].sha256)).toBe(true)
    const missing = loadedStressInputHashes(addon, () => {
      throw Object.assign(new Error('missing module'), { code: 'MODULE_NOT_FOUND' })
    })
    expect(missing.slice(3).every((hash) => hash.unavailable === 'MODULE_NOT_FOUND')).toBe(true)
  })

  it('preserves OSC boundaries while redacting their title payload and adjacent CSI text', () => {
    const esc = String.fromCharCode(27)
    const raw = `${esc}]0;private@sensitive.test${esc}\\${esc}[31mprivate@sensitive.test`
    const sanitized = sanitizeStressText(raw)
    expect(sanitized).not.toContain('private@')
    expect(sanitized).not.toContain('sensitive.test')
    expect(sanitized).toContain(`${esc}]0;`)
    expect(sanitized).toContain(`${esc}\\${esc}[31m`)
    expect(sanitized.length).toBe(raw.length)
  })

  it.each([
    ['email domain', 'private@', 'sensitive.test', ['[31m']],
    ['email name', 'pri', 'vate@sensitive.test', ['[31m', '[1m']],
    ['vendor key', 'sk-secret01', '234567890abcdefghijkl', ['[31m', '[1m']],
    ['bearer token', 'Bearer secret01', '234567890abcdefghijkl', ['[31m', '[1m']]
  ])(
    'redacts %s interrupted by adjacent controls without moving their bytes',
    (_kind, before, after, fragments) => {
      const esc = String.fromCharCode(27)
      const controls = fragments.map((fragment) => esc + fragment).join('')
      const raw = `${before}${controls}${after}`
      const sanitized = sanitizeStressText(raw)
      expect(sanitized).not.toContain(before)
      expect(sanitized).not.toContain(after)
      expect(sanitized.slice(before.length, before.length + controls.length)).toBe(controls)
      expect(sanitized.length).toBe(raw.length)
    }
  )

  it('scrubs an interrupted OSC title independently from the adjacent rendered address', () => {
    const esc = String.fromCharCode(27)
    const title = `private@${esc}[31msensitive.test`
    const raw = `${esc}]0;${title}${esc}\\private@sensitive.test`
    const sanitized = sanitizeStressText(raw)
    expect(sanitized).not.toContain('private@')
    expect(sanitized).not.toContain('sensitive.test')
    expect(sanitized.slice(0, 4)).toBe(`${esc}]0;`)
    expect(sanitized.slice(12, 17)).toBe(`${esc}[31m`)
    expect(sanitized.slice(4 + title.length, 6 + title.length)).toBe(`${esc}\\`)
    expect(sanitized.length).toBe(raw.length)
  })

  it('keeps the warmup survivor and newest terminals beyond eleven rounds', () => {
    const events = []
    const observer = createStressObserver((phase, details) => events.push({ phase, ...details }))
    const survivor = terminal()
    observer.watch(survivor, { round: -1, slot: -1 })
    let last
    for (let round = 0; round < 11; round += 1) {
      for (let slot = 0; slot < 3; slot += 1) {
        last = terminal()
        last.proc.pid = 1000 + round * 3 + slot
        observer.watch(last, { round, slot })
      }
    }
    const agent = last.proc._agent
    expect(agent._$onProcessExit(4, 'extra')).toBe('original-result')
    expect(agent.exitCode).toBe(4)
    expect(events.at(-1)).toMatchObject({ phase: 'native-exit-callback', round: 10, slot: 2 })
    last.exited = true
    last.proc.emit('ptyExit', { exitCode: 4 })
    expect(events.at(-1)).toMatchObject({ phase: 'pty-exit-callback', round: 10, slot: 2 })
    observer.pending('readiness-timeout-state')
    const snapshot = events.at(-1)
    expect(snapshot.omittedRecords).toBe(2)
    expect(snapshot.records).toHaveLength(32)
    expect(snapshot.records[0]).toMatchObject({ round: -1, slot: -1 })
    expect(snapshot.records[1]).toMatchObject({ round: 0, slot: 2 })
    expect(snapshot.records.at(-1)).toMatchObject({
      round: 10,
      slot: 2,
      nativeExitCode: 4,
      exitCallbackObserved: true
    })
  })

  it('retains late terminal state after exhausting the 256-milestone budget', () => {
    const { observer, events, record: survivor } = observation()
    const worker = survivor.proc._agent._conoutSocketWorker._worker
    for (let index = 0; index < 300; index += 1) {
      worker.emit('message', 1)
    }
    let last
    for (let index = 0; index < 40; index += 1) {
      last = terminal()
      last.proc.pid = 2000 + index
      observer.watch(last, { round: index, slot: 2 })
    }
    expect(last.proc._agent._$onProcessExit(7)).toBe('original-result')
    last.exited = true
    last.proc.emit('ptyExit', { exitCode: 7 })
    expect(events).toHaveLength(256)
    observer.pending('exit-drain-timeout-state')
    const snapshot = events.at(-1)
    expect(snapshot.observerEvents).toBe(256)
    expect(snapshot.omittedEvents).toBeGreaterThan(0)
    expect(snapshot.omittedRecords).toBe(9)
    expect(snapshot.records).toHaveLength(32)
    expect(snapshot.records.at(-1)).toMatchObject({
      shellPid: 2039,
      nativeExitCode: 7,
      exitCallbackObserved: true
    })
  })

  it.each([
    ['username', 'plain'],
    ['username', 'csi'],
    ['username', 'osc'],
    ['hostname', 'plain'],
    ['hostname', 'csi'],
    ['hostname', 'osc']
  ])('scrubs the entire %s email in %s framing', (identity, framing) => {
    const name = identity === 'username' ? userInfo().username : hostname()
    const esc = String.fromCharCode(27)
    const csi = `${esc}[31m`
    const email = `${name}@privatecorp.test`
    const raw =
      framing === 'csi'
        ? `${name}${csi}@privatecorp.test`
        : framing === 'osc'
          ? `${esc}]0;${email}${esc}\\`
          : email
    const sanitized = sanitizeStressText(raw)
    expect(sanitized).not.toContain(name)
    expect(sanitized).not.toContain('privatecorp.test')
    expect(sanitized.length).toBe(raw.length)
    const visible = sanitized
      .replaceAll(csi, '')
      .replaceAll(`${esc}]0;`, '')
      .replaceAll(`${esc}\\`, '')
    expect(scanTranscriptForSecrets(visible)).toEqual([])
    if (framing === 'csi') {
      expect(sanitized.slice(name.length, name.length + csi.length)).toBe(csi)
    } else if (framing === 'osc') {
      expect(sanitized.slice(0, 4)).toBe(`${esc}]0;`)
      expect(sanitized.slice(-2)).toBe(`${esc}\\`)
    }
  })

  it.each(['vendor', 'bearer'])(
    'keeps %s priority when a credential contains the local username',
    (kind) => {
      const name = userInfo().username
      const esc = String.fromCharCode(27)
      const csi = `${esc}[31m`
      const prefix = kind === 'vendor' ? 'sk-' : 'Bearer '
      const raw = `${prefix}${name}${csi}01234567890123456789`
      const sanitized = sanitizeStressText(raw)
      expect(sanitized).not.toContain(name)
      expect(sanitized).not.toContain('01234567890123456789')
      expect(sanitized.length).toBe(raw.length)
      expect(
        sanitized.slice(prefix.length + name.length, prefix.length + name.length + csi.length)
      ).toBe(csi)
      expect(scanTranscriptForSecrets(sanitized.replaceAll(csi, ''))).toEqual([])
    }
  )
})
