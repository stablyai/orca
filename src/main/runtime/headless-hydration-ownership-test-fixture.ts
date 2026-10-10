import { afterEach, vi } from 'vitest'
import './orca-runtime-test-lifecycle.spec'
import { OrcaRuntimeService } from './orca-runtime'
import { store, syncSinglePty } from './orca-runtime-test-fixtures.spec'

export const PTY_ID = 'pty-hydration-owner'
export const SIZE = { cols: 80, rows: 24 }
export const RETIRED_SNAPSHOT = {
  data: '\x1b]7;file:///retired-context\x07RETIRED-SEED',
  lastTitle: 'Codex working',
  ...SIZE
}

export class HydrationRuntime extends OrcaRuntimeService {
  model() {
    const state = this.headlessTerminals.get(PTY_ID)
    if (!state) {
      throw new Error('Expected headless model')
    }
    return state
  }

  retainedState() {
    return {
      model: this.headlessTerminals.has(PTY_ID),
      hydration: this.headlessHydrationState.get(PTY_ID),
      cwd: this.terminalCwdByPtyId.get(PTY_ID),
      titleTracker: this.ptyTitleTrackersByPtyId.has(PTY_ID),
      recentOutput: this.recentPtyOutputById.has(PTY_ID),
      providerPreferred: this.providerSnapshotPreferredPtys.has(PTY_ID),
      generation: this.ptyLifecycleGenerationById.get(PTY_ID),
      snapshotScans: this.providerModeSnapshotScansByPtyId.get(PTY_ID)?.size ?? 0
    }
  }

  preferProvider() {
    this.providerSnapshotPreferredPtys.add(PTY_ID)
  }

  replaceExecutionContext() {
    this.replaceHeadlessTerminalAfterExecutionContextChange(PTY_ID)
  }

  captureProvider() {
    return this.captureProviderTerminalBuffer(PTY_ID, {}, this.getPtyLifecycleGeneration(PTY_ID))
  }

  providerTail(visibleScreenOnly: boolean) {
    return this.readProviderTerminalTailLines(PTY_ID, 10, { visibleScreenOnly })
  }
}

const runtimes: HydrationRuntime[] = []

export function createHydrationRuntime(): HydrationRuntime {
  const runtime = new HydrationRuntime(store)
  syncSinglePty(runtime, PTY_ID)
  runtimes.push(runtime)
  return runtime
}

export function retire(runtime: HydrationRuntime): void {
  runtime.onPtyExit(PTY_ID, 0, undefined, { providerExitObserved: true })
}

export const EMPTY_RETAINED_STATE = {
  model: false,
  hydration: undefined,
  cwd: undefined,
  titleTracker: false,
  recentOutput: false,
  providerPreferred: false,
  generation: undefined,
  snapshotScans: 0
}

afterEach(() => {
  for (const runtime of runtimes.splice(0)) {
    retire(runtime)
  }
  vi.restoreAllMocks()
})
