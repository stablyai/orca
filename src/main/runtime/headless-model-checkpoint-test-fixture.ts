import { afterEach, vi } from 'vitest'
import type { HeadlessEmulator } from '../daemon/headless-emulator'
import type { HeadlessModelConfiguration } from '../daemon/headless-model-checkpoint'
import type { TerminalViewAttributes } from '../../shared/terminal-view-attributes'
import { HydrationRuntime, PTY_ID, retire } from './headless-hydration-ownership-test-fixture'
import { store, syncSinglePty } from './orca-runtime-test-fixtures.spec'
import {
  _resetTerminalModelQueryAuthorityForTest,
  markNativeWindowsConptyPty
} from './terminal-model-query-authority'
import { _resetTerminalViewAttributesForTest } from './terminal-view-attribute-store'

export const MODEL_BUDGET = 1024 * 1024
export const IMAGE_CONFIGURATION = {
  cellSize: { width: 2, height: 2 },
  colors: {
    foreground: { rgba: 0xffffffff },
    background: { rgba: 0x000000ff },
    ansi: []
  }
}

export const CHECKPOINT_THEME: TerminalViewAttributes = {
  foreground: [200, 200, 200],
  background: [10, 10, 10],
  cursor: [200, 200, 200],
  ansi: Array.from({ length: 256 }, () => [20, 20, 20]),
  cursorStyle: 'bar',
  cursorBlink: false,
  colorSchemeMode: 'dark'
}

export class CheckpointRuntime extends HydrationRuntime {
  readonly constructed: HeadlessEmulator[] = []
  readonly replies = vi.fn(() => true)

  changeCaptureContext(kind: 'generation' | 'incarnation'): void {
    if (kind === 'generation') {
      this.advancePtyLifecycleGeneration(PTY_ID)
      return
    }
    const pty = this.ptysById.get(PTY_ID)
    if (!pty) {
      throw new Error('Expected PTY record')
    }
    pty.incarnationId = 'successor-incarnation'
  }

  initialize(conpty = false): void {
    if (conpty) {
      markNativeWindowsConptyPty(PTY_ID)
    }
    this.setPtyController({
      write: this.replies,
      kill: () => true,
      getForegroundProcess: async () => null,
      getSize: () => ({ cols: 20, rows: 10 }),
      resize: () => true
    })
    this.headlessTerminals.set(
      PTY_ID,
      this.createPtyHeadlessTerminalState(PTY_ID, { cols: 20, rows: 10 }, IMAGE_CONFIGURATION)
    )
  }

  protected override createPtyHeadlessEmulator(
    ptyId: string,
    configuration: HeadlessModelConfiguration,
    ownsModel: (model: HeadlessEmulator) => boolean
  ): HeadlessEmulator {
    const model = super.createPtyHeadlessEmulator(ptyId, configuration, ownsModel)
    this.constructed.push(model)
    return model
  }
}

const runtimes: CheckpointRuntime[] = []

export function createCheckpointRuntime(conpty = false): CheckpointRuntime {
  const runtime = new CheckpointRuntime(store)
  syncSinglePty(runtime, PTY_ID)
  runtime.initialize(conpty)
  runtimes.push(runtime)
  return runtime
}

export async function captureRuntime(runtime: CheckpointRuntime) {
  const capture = await runtime.captureHeadlessTerminalModelCheckpoint(PTY_ID, MODEL_BUDGET)
  if (!capture) {
    throw new Error('Expected complete model capture')
  }
  return capture
}

export function kittyImage(id = 7): string {
  return `\x1b_Ga=T,f=32,s=2,v=2,i=${id},q=2;${Buffer.alloc(16, 255).toString('base64')}\x1b\\`
}

afterEach(() => {
  for (const runtime of runtimes.splice(0)) {
    retire(runtime)
  }
  _resetTerminalModelQueryAuthorityForTest()
  _resetTerminalViewAttributesForTest()
  vi.restoreAllMocks()
})
