import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import type { RuntimeVisibleTerminalState } from './runtime-terminal-state-records'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: () => process.env.TMPDIR }
}))

class ScreenProbe extends OrcaRuntimeService {
  model() {
    return this.getOrCreateHeadlessTerminal('pty')
  }
  readScreen() {
    return this.readHeadlessVisibleTerminalState('pty')
  }
  replaceModel() {
    this.headlessTerminals.set(
      'pty',
      this.createPtyHeadlessTerminalState('pty', { cols: 120, rows: 40 })
    )
  }
  replaceGeneration() {
    this.advancePtyLifecycleGeneration('pty')
  }
  isCurrent(screen: RuntimeVisibleTerminalState): boolean {
    const publisher: unknown = this.antigravityScreenPermissions
    const deps: unknown =
      publisher && typeof publisher === 'object' && 'deps' in publisher ? publisher.deps : null
    if (
      !deps ||
      typeof deps !== 'object' ||
      !('isCurrent' in deps) ||
      typeof deps.isCurrent !== 'function'
    ) {
      throw new Error('Production screen validator missing')
    }
    return deps.isCurrent('pty', screen)
  }
  disposeModels() {
    this.antigravityScreenPermissions.forget('pty')
    for (const state of this.headlessTerminals.values()) {
      state.emulator.dispose()
    }
    this.headlessTerminals.clear()
  }
}
const probes: ScreenProbe[] = []
afterEach(() => {
  for (const runtime of probes.splice(0)) {
    runtime.disposeModels()
  }
})

async function probe() {
  const runtime = new ScreenProbe(null)
  probes.push(runtime)
  runtime.registerPty('pty', 'folder-workspace', null)
  runtime.onPtyData('pty', 'captured frame\r\n', Date.now())
  await runtime.readScreen()
  return runtime
}

it('does not claim a headless identity field absent from production reader results', () => {
  const source = readFileSync(join(__dirname, 'orca-runtime-visible-snapshot-preview.ts'), 'utf8')
  expect(source.includes('screen.headlessWriteChain')).toBe(false)
})

it('returns the actual generation and output sequence without an invented identity property', async () => {
  const runtime = await probe()
  const screen = await runtime.readScreen()
  expect(screen).toMatchObject({ sequence: runtime.getPtyOutputSequence('pty') })
  expect(screen).not.toHaveProperty('headlessWriteChain')
  expect(screen?.lines.join('\n')).toContain('captured frame')
  if (!screen) {
    throw new Error('Real screen missing')
  }
  expect(runtime.isCurrent(screen)).toBe(true)
})

it.each(['model', 'generation'] as const)(
  'rejects a replaced %s while its real write chain is pending',
  async (replacement) => {
    const runtime = await probe()
    const previous = runtime.model()
    const drain = Promise.withResolvers<void>()
    previous.writeChain = drain.promise
    const reading = runtime.readScreen()
    if (replacement === 'model') {
      runtime.replaceModel()
    } else {
      runtime.replaceGeneration()
    }
    drain.resolve()
    expect(await reading).toBeNull()
    if (replacement === 'model') {
      previous.emulator.dispose()
    }
  }
)

it('rejects a real frame overtaken by output or a newer generation', async () => {
  const runtime = await probe()
  const screen = await runtime.readScreen()
  if (!screen) {
    throw new Error('Real screen missing')
  }
  runtime.onPtyData('pty', 'new output\r\n', Date.now())
  expect(runtime.isCurrent(screen)).toBe(false)
  const next = await runtime.readScreen()
  if (!next) {
    throw new Error('New screen missing')
  }
  expect(runtime.isCurrent(next)).toBe(true)
  runtime.replaceGeneration()
  expect(runtime.isCurrent(next)).toBe(false)
})

it('rejects a real frame after the PTY disconnects', async () => {
  const runtime = await probe()
  const screen = await runtime.readScreen()
  if (!screen) {
    throw new Error('Real screen missing')
  }
  runtime.onPtyExit('pty', 0)
  expect(runtime.isCurrent(screen)).toBe(false)
})

it('rejects a real frame while its execution host is unverifiable', async () => {
  const runtime = await probe()
  const screen = await runtime.readScreen()
  if (!screen) {
    throw new Error('Real screen missing')
  }
  runtime.markPtyLivenessUnverifiable('pty', 'SSH provider contact lost')
  expect(runtime.isCurrent(screen)).toBe(false)
})
