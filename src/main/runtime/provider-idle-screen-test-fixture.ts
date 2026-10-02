import { afterEach, vi } from 'vitest'
import { HydrationRuntime, PTY_ID } from './headless-hydration-ownership-test-fixture'
import { store, syncSinglePty, TEST_WORKTREE_ID } from './orca-runtime-test-fixtures.spec'
import captured from './__fixtures__/codex-0-160-visible-screen.json'
import type { RuntimeTerminalProjection } from './orca-runtime-core'
import type { RuntimePtyController } from './runtime-pty-controller-contract'
import type { RuntimeTerminalWait } from '../../shared/runtime-types'
import type { TuiAgent } from '../../shared/tui-agent'
import type { RuntimeVisibleTerminalState } from './runtime-terminal-state-records'

export { PTY_ID }
export const CAPTURED_LINES = captured.lines
export const SNAPSHOT_SEQUENCE = 1000
export const PROVIDER_OWNER_RACES = ['record', 'incarnation', 'generation', 'output'] as const

export function changeProviderOwner(
  runtime: ProviderIdleRuntime,
  race: (typeof PROVIDER_OWNER_RACES)[number]
) {
  switch (race) {
    case 'record':
      runtime.replacePtyRecord()
      break
    case 'incarnation':
      runtime.pty().incarnationId = 'replacement-incarnation'
      break
    case 'generation':
      runtime.synchronizePtyOutputSequenceFromProvider(PTY_ID, { value: 0, generation: 'reset' })
      break
    case 'output':
      runtime.synchronizePtyOutputSequenceFromProvider(
        PTY_ID,
        { value: SNAPSHOT_SEQUENCE + 1, generation: 'continued' },
        runtime.getPtyOutputSequence(PTY_ID)
      )
      break
  }
}

export function providerSnapshot(lines = CAPTURED_LINES, alternateScreen = false) {
  return {
    data: `${alternateScreen ? '\x1b[?1049h' : ''}${lines.join('\r\n')}`,
    cols: 160,
    rows: 24,
    seq: SNAPSHOT_SEQUENCE,
    source: 'headless' as const,
    alternateScreen
  }
}

export class ProviderIdleRuntime extends HydrationRuntime {
  beforeParse: (() => Promise<void> | void) | null = null
  afterParse: (() => void) | null = null
  beforeEvidence: (() => void) | null = null
  beforeVisibleRead: (() => Promise<void> | void) | null = null

  pty() {
    const pty = this.ptysById.get(PTY_ID)
    if (!pty) {
      throw new Error('Expected provider PTY')
    }
    return pty
  }

  leaf() {
    const leaf = this.leaves.get(this.getLeafKey('tab-1', 'pane:1'))
    if (!leaf) {
      throw new Error('Expected provider leaf')
    }
    return leaf
  }

  handle(path: 'pty' | 'leaf') {
    return path === 'pty' ? this.issuePtyHandle(this.pty()) : this.issueHandle(this.leaf())
  }

  wholeScreen() {
    return this.readLiveTerminalScreenLines(PTY_ID)
  }

  agent() {
    return this.getPaneAgentForTuiIdle(PTY_ID)
  }

  quiet() {
    for (const record of [this.pty(), this.leaf()]) {
      record.lastOutputAt = Date.now() - 4000
      record.lastAgentStatus = null
      record.lastOscTitle = null
    }
  }

  pendingHydration(preferProvider = true) {
    this.headlessHydrationState.set(PTY_ID, 'pending')
    if (!preferProvider) {
      this.providerSnapshotPreferredPtys.delete(PTY_ID)
    }
  }

  removeModel() {
    this.headlessTerminals.get(PTY_ID)?.emulator.dispose()
    this.headlessTerminals.delete(PTY_ID)
  }

  trustWholeModel() {
    this.providerSnapshotPreferredPtys.delete(PTY_ID)
    this.headlessHydrationState.set(PTY_ID, 'done')
  }

  replacePtyRecord() {
    this.ptysById.set(PTY_ID, { ...this.pty() })
  }

  rebindLeaf() {
    this.leaves.set(this.getLeafKey('tab-1', 'pane:1'), {
      ...this.leaf(),
      ptyId: 'replacement-pty'
    })
  }

  providerViewport() {
    return this.readVisibleTerminalState(PTY_ID, true)
  }

  providerIdleScreen() {
    return this.readTuiIdleProviderScreen(PTY_ID)
  }

  protected override getPaneAgentForTuiIdle(ptyId: string | null | undefined): TuiAgent | null {
    this.beforeEvidence?.()
    return super.getPaneAgentForTuiIdle(ptyId)
  }

  pendingResources() {
    return {
      waiters: Array.from(this.terminalWaiters.handles()).length,
      timers: this.terminalIdlePolls.activeTimerCount,
      visibleReads: this.providerVisibleStateReadsByPtyId.size,
      acquisitions: this.providerBufferAcquisitionsByPtyId.size,
      scans: this.providerModeSnapshotScansByPtyId.size
    }
  }

  protected override async readHeadlessVisibleTerminalState(
    ptyId: string
  ): Promise<RuntimeVisibleTerminalState | null> {
    await this.beforeVisibleRead?.()
    return super.readHeadlessVisibleTerminalState(ptyId)
  }

  protected override async parseVisibleSnapshot(snapshot: {
    data: string
    cols: number
    rows: number
  }): Promise<RuntimeTerminalProjection> {
    await this.beforeParse?.()
    const projection = await super.parseVisibleSnapshot(snapshot)
    this.afterParse?.()
    return projection
  }
}

export function observeIdleWait(
  pane: { runtime: ProviderIdleRuntime; handle: string },
  options: { timeoutMs?: number; signal?: AbortSignal } = {}
) {
  if (!vi.isFakeTimers()) {
    vi.useFakeTimers()
  }
  let outcome: RuntimeTerminalWait | string | null = null
  const settled = pane.runtime
    .waitForTerminal(pane.handle, { condition: 'tui-idle', timeoutMs: 8000, ...options })
    .then(
      (result) => (outcome = result),
      (error: Error) => (outcome = error.message)
    )
  return { settled, outcome: () => outcome }
}

const runtimes: ProviderIdleRuntime[] = []

export async function createProviderIdlePane(
  path: 'pty' | 'leaf' = 'pty',
  controller: Partial<RuntimePtyController> = {},
  dependencies?: ConstructorParameters<typeof HydrationRuntime>[2]
) {
  const runtime = new ProviderIdleRuntime(store, undefined, dependencies)
  runtimes.push(runtime)
  syncSinglePty(runtime, PTY_ID)
  runtime.registerPty(PTY_ID, TEST_WORKTREE_ID, null, {
    tabId: 'tab-1',
    leafId: 'pane:1',
    incarnationId: 'provider-idle-incarnation',
    agentLaunchAuthority: { launchToken: 'provider-idle-launch', launchAgent: 'codex' }
  })
  runtime.pty().foregroundAgent = 'codex'
  const serializeProviderBuffer = vi.fn(async () => providerSnapshot())
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    serializeProviderBuffer,
    ...controller
  })
  runtime.onPtyData(PTY_ID, 'Retained redraw suffix\r\n', 60)
  await runtime.model().writeChain
  runtime.preferProvider()
  runtime.quiet()
  return { runtime, handle: runtime.handle(path), serializeProviderBuffer }
}

afterEach(() => {
  vi.useRealTimers()
  for (const runtime of runtimes.splice(0)) {
    runtime.onPtyExit(PTY_ID, 0, undefined, { providerExitObserved: true })
  }
  vi.restoreAllMocks()
})
