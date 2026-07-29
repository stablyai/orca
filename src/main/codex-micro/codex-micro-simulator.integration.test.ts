import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import type { CodexMicroSettings } from '../../shared/codex-micro-settings'
import { CODEX_MICRO_CONTROL_IDS, type CodexMicroInputEvent } from '../../shared/codex-micro-types'
import { CodexMicroCoordinator } from './coordinator'
import { CodexMicroSidecarProcess } from './sidecar-process'

const root = resolve(__dirname, '../../..')
const manifest = resolve(root, 'native/codex-micro/Cargo.toml')
const binary = resolve(
  root,
  `native/codex-micro/target/debug/codex-micro${process.platform === 'win32' ? '.exe' : ''}`
)
const fixtures = resolve(root, 'native/codex-micro/fixtures')

class Store {
  private listeners = new Set<(updates: { codexMicro?: CodexMicroSettings }) => void>()
  constructor(private value: CodexMicroSettings) {}
  getSettings(): { codexMicro: CodexMicroSettings } {
    return { codexMicro: this.value }
  }
  onSettingsChanged(listener: (updates: { codexMicro?: CodexMicroSettings }) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  update(updates: Partial<CodexMicroSettings>): void {
    this.value = { ...this.value, ...updates }
    for (const listener of this.listeners) {
      listener({ codexMicro: this.value })
    }
  }
}

const settings = (): CodexMicroSettings => ({
  enabled: true,
  lightingEnabled: true,
  brightness: 50,
  idleTimeoutSeconds: 300,
  dialMode: 'navigate',
  mappings: {}
})

beforeAll(() => {
  const result = spawnSync('cargo', ['build', '--manifest-path', manifest], {
    cwd: root,
    encoding: 'utf8'
  })
  if (result.status !== 0) {
    throw new Error(result.stderr || 'failed to build Codex Micro simulator')
  }
})

describe('Codex Micro simulator vertical slice', () => {
  it('connects known firmware, emits every proven input, and dedupes unchanged output', async () => {
    const store = new Store(settings())
    const inputs: CodexMicroInputEvent[] = []
    const frames: Record<string, unknown>[] = []
    const coordinator = new CodexMicroCoordinator({
      store,
      resolveBinaryPath: () => binary,
      createProcess: (path) => {
        const process = new CodexMicroSidecarProcess(path, ['--simulate', fixtures])
        process.on('frame', (frame) => {
          if (isRecord(frame)) {
            frames.push(frame)
          }
        })
        return process
      }
    })
    coordinator.subscribeInput((input) => inputs.push(input))
    coordinator.start()

    await waitFor(() => coordinator.getState().kind === 'connected')
    await waitFor(() => inputs.some((input) => input.kind === 'radar'))
    const controls = new Set(
      inputs.filter((input) => input.kind === 'control').map((input) => input.control)
    )
    for (const control of CODEX_MICRO_CONTROL_IDS) {
      expect(controls).toContain(control)
    }

    await waitFor(() => snapshotResults(frames).length === 2)
    store.update({ brightness: 50 })
    await delay(100)
    expect(snapshotResults(frames)).toHaveLength(2)
    store.update({ brightness: 75 })
    await waitFor(() => snapshotResults(frames).length === 4)
    expect(snapshotResults(frames).every((frame) => frame.outcome === 'matched')).toBe(true)
    coordinator.release()
  })

  it('fails unknown firmware closed to read-only while input remains available', async () => {
    const store = new Store(settings())
    const inputs: CodexMicroInputEvent[] = []
    const frames: Record<string, unknown>[] = []
    const coordinator = new CodexMicroCoordinator({
      store,
      resolveBinaryPath: () => binary,
      createProcess: (path) => {
        const process = new CodexMicroSidecarProcess(path, [
          '--simulate',
          fixtures,
          '--simulate-unknown-firmware'
        ])
        process.on('frame', (frame) => {
          if (isRecord(frame)) {
            frames.push(frame)
          }
        })
        return process
      }
    })
    coordinator.subscribeInput((input) => inputs.push(input))
    coordinator.start()

    await waitFor(() => coordinator.getState().kind === 'read-only')
    await waitFor(() => inputs.some((input) => input.kind === 'control'))
    await delay(100)
    expect(snapshotResults(frames)).toEqual([])
    coordinator.release()
  })
})

function snapshotResults(frames: Record<string, unknown>[]): Record<string, unknown>[] {
  return frames.filter((frame) => frame.type === 'snapshot_result')
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('timed out waiting for simulator state')
    }
    await delay(10)
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
