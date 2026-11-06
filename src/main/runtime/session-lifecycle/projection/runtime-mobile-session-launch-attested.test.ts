import { expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { projectRuntimeMobileSessionTabs } from './runtime-mobile-session-projection'
import type { RuntimeMobileSessionProjectionHost } from './runtime-mobile-session-projection-contract'
import type { RuntimeMobileSessionTabsSnapshot } from '../../../../shared/runtime-session-contracts'

const PTY_ID = 'pty-paired'
const TAB_ID = '11111111-1111-4111-8111-111111111111'
const LEAF_ID = '22222222-2222-4222-8222-222222222222'
const INCARNATION = 'paired-incarnation'

class PairedHostRuntime extends OrcaRuntimeService {
  ptyRecord(ptyId: string) {
    return this.ptysById.get(ptyId)
  }
}

function frameLaunchAttested(runtime: PairedHostRuntime): boolean | undefined {
  const pty = runtime.ptyRecord(PTY_ID)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stub implements every host member this projection path calls.
  const host = {
    tabs: new Map(),
    leaves: new Map(),
    ptysById: new Map([[PTY_ID, pty]]),
    getPtyAvailability: () => null,
    isSessionTitlePublisher: () => false,
    getLiveBrowserTabs: () => new Map(),
    getProviderSessionRows: () => [],
    getProviderSessionSnapshot: () => [],
    getLeafKey: () => LEAF_ID,
    findPty: () => pty,
    getRetainedStatus: () => null,
    getTrackedTitle: () => null,
    getTitleDisplayClear: () => null,
    issuePtyHandle: () => 'handle',
    recordPty: () => pty,
    buildPtyStatus: () => ({
      agentStatus: {
        agentType: 'claude',
        state: 'done',
        prompt: '',
        updatedAt: 1,
        stateStartedAt: 1
      }
    }),
    sanitizeGroups: () => [],
    pruneGroupLayout: () => null,
    collectTabIds: () => new Set()
  } as unknown as RuntimeMobileSessionProjectionHost
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: one terminal tab is the only snapshot field this projection path reads.
  const snapshot = {
    worktree: 'workspace',
    publicationEpoch: 'headless:epoch',
    tabs: [
      {
        type: 'terminal',
        id: `${TAB_ID}::${LEAF_ID}`,
        parentTabId: TAB_ID,
        leafId: LEAF_ID,
        ptyId: PTY_ID,
        title: 'Claude',
        isActive: true
      }
    ]
  } as RuntimeMobileSessionTabsSnapshot
  const tab = projectRuntimeMobileSessionTabs(snapshot, host).tabs[0]
  return tab && 'launchAttested' in tab ? tab.launchAttested : undefined
}

// A paired client keeps a pane's note only on this fact, so a finished launch must turn it false.
it('a paired host frame stops attesting a launch once its command finishes', () => {
  const runtime = new PairedHostRuntime(null)
  runtime.setPtyController({
    write: vi.fn(() => true),
    kill: vi.fn(),
    getForegroundProcess: async () => null
  })
  runtime.registerPty(PTY_ID, 'workspace', null, {
    tabId: TAB_ID,
    leafId: LEAF_ID,
    incarnationId: INCARNATION,
    agentLaunchAuthority: {
      launchToken: 'launch-1',
      launchAgent: 'claude',
      launchConfig: { agentArgs: '--verbose', agentEnv: {} }
    }
  })
  expect(frameLaunchAttested(runtime)).toBe(true)

  runtime.emitDaemonPtyTransientFact(PTY_ID, { kind: 'command-finished', exitCode: 0 })

  expect(frameLaunchAttested(runtime)).toBe(false)
})
