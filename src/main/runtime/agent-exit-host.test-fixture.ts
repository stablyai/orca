import { vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime-test-mocks.spec'
import {
  HEADLESS_LEAF_ID,
  HEADLESS_SECOND_LEAF_ID,
  TEST_WORKTREE_ID,
  makeHeadlessTerminalLayout,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} from './orca-runtime-test-fixtures.spec'
import type { RuntimeStore } from './runtime-store-contract'
import type { Tab } from '../../shared/tab-types'
import type { TerminalLayoutSnapshot } from '../../shared/terminal-tab-types'
import type { TerminalProcessInspection } from '../../shared/terminal-process-inspection'
import type {
  AgentProcessIdentity,
  AgentProcessPresence,
  AgentProcessVerdict
} from '../../shared/agent-process-presence'
import { settledWriteStub } from '../providers/settled-pty-write-stub'

export const A = HEADLESS_LEAF_ID
export const B = HEADLESS_SECOND_LEAF_ID
export const PTY: Record<string, string> = { [A]: 'pty-a', [B]: 'pty-b' }
export const WT = TEST_WORKTREE_ID

export type ForegroundAgent = { name: 'claude' | 'codex'; pid: number; startTime: string }

/** A fenced, incarnation-matched POSIX capture: the named agent in front, or the shell. */
export function fencedCapture(
  ptyId: string,
  incarnationId: string,
  agent: ForegroundAgent | null
): TerminalProcessInspection {
  return {
    foregroundProcess: agent?.name ?? 'zsh',
    hasChildProcesses: agent !== null,
    foregroundProcessEvidence: {
      authorityGeneration: 'gen-1',
      observationEpoch: 1,
      capturedAgeMs: 0,
      ptyId,
      ptyIncarnationId: incarnationId,
      verdict: 'live',
      processName: agent?.name ?? null,
      fence: {
        platform: 'posix',
        shellPid: 100,
        shellStartTime: 'shell-start',
        tty: 'ttys001',
        foregroundPgid: agent?.pid ?? 100,
        ...(agent ? { process: { pid: agent.pid, startTime: agent.startTime } } : {})
      }
    }
  }
}

function unifiedTab(viewMode?: 'terminal' | 'chat'): Tab {
  return {
    id: 'host-tab',
    entityId: 'host-tab',
    groupId: 'group-1',
    worktreeId: WT,
    contentType: 'terminal',
    label: 'Persisted Terminal',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    ...(viewMode ? { viewMode } : {})
  }
}

/**
 * A headless host tab whose panes run PTYs on this machine. The foreground capture and the
 * targeted PID probe are scripted; everything else is the production runtime.
 */
export function makeAgentExitHost(options: {
  viewMode?: 'terminal' | 'chat'
  leaves: 1 | 2
  chatLeafId?: string
  tabLaunchAgent?: 'claude' | 'codex'
  connectionId?: string
}) {
  const ptyIds = options.leaves === 2 ? { [A]: PTY[A]!, [B]: PTY[B]! } : { [A]: PTY[A]! }
  const layout: TerminalLayoutSnapshot = {
    ...makeHeadlessTerminalLayout(ptyIds),
    ...(options.chatLeafId ? { chatLeafId: options.chatLeafId } : {})
  }
  const base = makeWorkspaceSessionWithHeadlessTerminal()
  const row = base.tabsByWorktree[WT]![0]!
  const session = {
    ...base,
    tabsByWorktree: {
      [WT]: [
        {
          ...row,
          ptyId: PTY[A]!,
          ...(options.tabLaunchAgent ? { launchAgent: options.tabLaunchAgent } : {})
        }
      ]
    },
    unifiedTabs: { [WT]: [unifiedTab(options.viewMode)] },
    terminalLayoutsByTabId: { 'host-tab': layout }
  }
  const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(session)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The shared fixture implements RuntimeStore; its annotation erases the Vitest mock call signatures.
  const store = runtimeStore as RuntimeStore
  const recordProvenEnd = vi.fn((_paneKey: string, _agent: string, _checkStartedAtMs: number) => {})
  const runtime = new OrcaRuntimeService(store, undefined, {
    checkHookAgentPresence: async () => null,
    recordHostProvenAgentEnd: recordProvenEnd
  })
  const foreground = new Map<string, ForegroundAgent | null>()
  const alive = new Set<number>()
  const write = vi.fn((_ptyId: string, _data: string) => true)
  const inspectProcess = vi.fn(async (ptyId: string) =>
    fencedCapture(ptyId, `inc-${ptyId}`, foreground.get(ptyId) ?? null)
  )
  runtime.setPtyController({
    write,
    writeWithSettlement: settledWriteStub(write),
    kill: vi.fn(),
    getForegroundProcess: vi.fn(async () => null),
    inspectProcess
  })
  const probe = vi.fn(async (identities: readonly AgentProcessIdentity[]) =>
    identities.map((identity): AgentProcessVerdict => (alive.has(identity.pid) ? 'live' : 'exited'))
  )
  const bootstrap = vi.fn(async (captured: { pid: number; startTime: string }) => ({
    pid: captured.pid,
    platform: 'darwin' as const,
    startTime: `utc:${captured.startTime}`
  }))
  runtime['probeAgentProcessIdentities'] = probe
  runtime['bootstrapAgentIdentity'] = bootstrap
  for (const leafId of Object.keys(ptyIds)) {
    runtime.registerPty(PTY[leafId]!, WT, options.connectionId ?? null, {
      tabId: 'host-tab',
      leafId,
      incarnationId: `inc-${PTY[leafId]}`,
      agentLaunchAuthority: { launchToken: `token-${leafId}`, launchAgent: 'claude' }
    })
  }
  const paneKey = (leafId: string): string => `host-tab:${leafId}`
  const owner = (leafId: string, presence: AgentProcessPresence | undefined): void =>
    runtime.noteAgentOwnerPresenceChange({
      paneKey: paneKey(leafId),
      previous: undefined,
      presence
    })
  const handleFor = (leafId: string): string => {
    const handle = runtime['handleByPtyId'].get(PTY[leafId]!)
    if (!handle) {
      throw new Error(`no handle for ${leafId}`)
    }
    return handle
  }
  return {
    runtime,
    store,
    write,
    inspectProcess,
    probe,
    bootstrap,
    recordProvenEnd,
    foreground,
    alive,
    owner,
    hostPair: () => ({
      viewMode: getSession().unifiedTabs?.[WT]?.[0]?.viewMode,
      owner: getSession().terminalLayoutsByTabId['host-tab']?.chatLeafId
    }),
    hostLaunchAgent: () => getSession().tabsByWorktree[WT]?.[0]?.launchAgent,
    published: async () =>
      (await runtime.listMobileSessionTabs(`id:${WT}`)).tabs.flatMap((tab) =>
        tab.type === 'terminal' ? [tab] : []
      ),
    snapshotVersion: () => runtime['mobileSessionTabsByWorktree'].get(WT)?.snapshotVersion,
    writeCount: () => vi.mocked(store.setWorkspaceSession!).mock.calls.length,
    chatSend: (leafId: string, actionId: string, text = 'rm -rf build') =>
      runtime.sendTerminal(
        handleFor(leafId),
        { text, enter: true },
        { inputKind: 'driving', chatInput: { actionId } }
      ),
    rawSend: (leafId: string, text: string) =>
      runtime.sendTerminal(handleFor(leafId), { text }, { inputKind: 'driving' })
  }
}

export async function flush(): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    await Promise.resolve()
  }
}
