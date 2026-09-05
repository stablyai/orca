import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CodexMicroSettings } from '../../shared/codex-micro-settings'
import { CodexMicroCoordinator } from './coordinator'

class FakeProcess extends EventEmitter {
  started = false
  stopped = false
  written: Record<string, unknown>[] = []
  start(): void {
    this.started = true
  }
  stop(): void {
    this.stopped = true
    this.emit('exit', 0, null)
  }
  write(message: Record<string, unknown>): void {
    this.written.push(message)
  }
}

class FakeStore {
  private listeners = new Set<(updates: { codexMicro?: CodexMicroSettings }) => void>()
  constructor(private codexMicro: CodexMicroSettings) {}
  getSettings(): { codexMicro: CodexMicroSettings } {
    return { codexMicro: this.codexMicro }
  }
  onSettingsChanged(listener: (updates: { codexMicro?: CodexMicroSettings }) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  update(updates: Partial<CodexMicroSettings>): void {
    this.codexMicro = { ...this.codexMicro, ...updates }
    for (const listener of this.listeners) {
      listener({ codexMicro: this.codexMicro })
    }
  }
}

const settings = (overrides: Partial<CodexMicroSettings> = {}): CodexMicroSettings => ({
  enabled: true,
  lightingEnabled: false,
  brightness: 100,
  idleTimeoutSeconds: 300,
  dialMode: 'navigate',
  mappings: {},
  ...overrides
})

describe('CodexMicroCoordinator', () => {
  let processes: FakeProcess[]
  let store: FakeStore
  let coordinator: CodexMicroCoordinator

  beforeEach(() => {
    vi.useFakeTimers()
    processes = []
    store = new FakeStore(settings())
    coordinator = new CodexMicroCoordinator({
      store,
      resolveBinaryPath: () => '/bin/codex-micro',
      createProcess: () => {
        const process = new FakeProcess()
        processes.push(process)
        return process
      }
    })
  })

  afterEach(() => {
    coordinator.dispose()
    vi.useRealTimers()
  })

  it('does not spawn while disabled and stops when disabled later', () => {
    store.update({ enabled: false })
    coordinator.start()
    expect(processes).toHaveLength(0)
    expect(coordinator.getState()).toEqual({ kind: 'disabled' })

    store.update({ enabled: true })
    expect(processes).toHaveLength(1)
    store.update({ enabled: false })
    expect(processes[0]!.stopped).toBe(true)
  })

  it('accepts parsed state/input frames and drops invalid controls', () => {
    const inputs: unknown[] = []
    coordinator.subscribeInput((event) => inputs.push(event))
    coordinator.start()
    processes[0]!.emit('frame', {
      version: 1,
      type: 'connection_state',
      state: { kind: 'connected', firmware: 'v0.4.1' }
    })
    processes[0]!.emit('frame', {
      version: 1,
      type: 'input_event',
      event: { kind: 'control', control: 'AG00', action: 1 }
    })
    processes[0]!.emit('frame', {
      version: 1,
      type: 'input_event',
      event: { kind: 'control', control: 'INVALID', action: 1 }
    })

    expect(coordinator.getState()).toEqual({ kind: 'connected', firmware: 'v0.4.1' })
    expect(inputs).toEqual([{ kind: 'control', control: 'AG00', action: 1 }])
  })

  it('uses bounded backoff and opens the crash fuse after three failures', () => {
    coordinator.start()
    processes[0]!.emit('exit', 1, null)
    vi.advanceTimersByTime(999)
    expect(processes).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(processes).toHaveLength(2)
    processes[1]!.emit('exit', 1, null)
    vi.advanceTimersByTime(2_000)
    processes[2]!.emit('exit', 1, null)
    expect(coordinator.getState()).toMatchObject({ kind: 'error', code: 'crash-loop' })
  })

  it('does not auto-restart after release but retry starts a new child', () => {
    coordinator.start()
    coordinator.release()
    expect(processes[0]!.written).toEqual([{ type: 'release' }])
    vi.advanceTimersByTime(60_000)
    expect(processes).toHaveLength(1)
    coordinator.retry()
    expect(processes).toHaveLength(2)
  })

  it('writes lighting only for writable firmware and dedupes unchanged snapshots', () => {
    store.update({ lightingEnabled: true, brightness: 50 })
    coordinator.start()
    processes[0]!.emit('frame', {
      version: 1,
      type: 'connection_state',
      state: { kind: 'read-only', firmware: 'v9', reason: 'unknown-firmware' }
    })
    expect(processes[0]!.written).toEqual([])

    processes[0]!.emit('frame', {
      version: 1,
      type: 'connection_state',
      state: { kind: 'connected', firmware: 'v0.4.1' }
    })
    expect(processes[0]!.written).toHaveLength(1)
    expect(processes[0]!.written[0]!.thstatus).toHaveLength(6)
    store.update({ brightness: 50 })
    expect(processes[0]!.written).toHaveLength(1)
    store.update({ brightness: 75 })
    expect(processes[0]!.written).toHaveLength(2)
  })
})
