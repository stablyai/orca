import type { ExecutionHostId } from '../../shared/execution-host'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type { HostWorktreeTarget } from '../../shared/worktree/host-qualified-identity'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../shared/runtime-session-contracts'
import { AgentHookServer } from '../agent-hooks/server'
import { OrcaRuntimeService } from './orca-runtime'
import type { MobileNotificationEvent } from './runtime-mobile-notification-controller'
import type { RuntimeStore } from './runtime-store-contract'

export const terminalHostCleanups: (() => void)[] = []

export const WT = 'repo-1::/tmp/worktree-a'
export const PANE = 'tab-1:11111111-1111-4111-8111-111111111111'
type SidebarRecord = Pick<
  WorktreeMeta,
  'displayName' | 'hostId' | 'lastActivityAt' | 'smartTier' | 'smartAt' | 'isUnread'
>

class TestRuntime extends OrcaRuntimeService {
  readonly controller = this.mobileNotifications
  readonly announcements = this.mobileNotifications.announcedNotifications
}

export function createHost(windowId: number | null = HEADLESS_RUNTIME_WINDOW_ID) {
  const records = new Map<string, SidebarRecord>()
  const addWorkspace = (id: string, hostId: ExecutionHostId): SidebarRecord => {
    const record = { displayName: 'feature', hostId, lastActivityAt: 0, isUnread: false }
    records.set(`${hostId}|${id}`, record)
    return record
  }
  addWorkspace(WT, 'local')
  const store = {
    getRepos: () => [],
    getRepo: (id: string) =>
      id === 'repo-1' ? { id, connectionId: null, displayName: 'orca' } : undefined,
    getSettings: () => ({ notifications: { enabled: true, agentTaskComplete: true } }),
    getWorktreeMeta: (id: string) => records.get(`local|${id}`),
    getWorktreeMetaForHost: (id: string, hostId: ExecutionHostId) => records.get(`${hostId}|${id}`),
    setWorktreeMeta: (target: HostWorktreeTarget, updates: Partial<SidebarRecord>) => {
      const record = records.get(`${target.hostId}|${target.id}`)
      if (record) {
        Object.assign(record, updates)
      }
    },
    getAllWorktreeMeta: () => ({}),
    getFolderWorkspaces: () => [{ id: 'f1', name: 'Notes', projectGroupId: 'g1' }],
    getProjectGroups: () => [{ id: 'g1', name: 'Research' }]
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: backs the notification and sidebar paths exercised here.
  const runtime = new TestRuntime(store as unknown as RuntimeStore)
  if (windowId !== null) {
    runtime.syncWindowGraph(windowId, { tabs: [], leaves: [] })
  }
  const server = new AgentHookServer()
  terminalHostCleanups.push(runtime.attachAgentStatusStore(server))
  const alerts: MobileNotificationEvent[] = []
  runtime.onNotificationDispatched((event) => alerts.push(event))
  const report = (
    state: 'working' | 'done' | 'waiting',
    sessionBoundary?: true,
    worktreeId = WT,
    paneKey = PANE
  ): void =>
    server.ingestTerminalStatus({
      paneKey,
      tabId: paneKey.split(':')[0],
      worktreeId,
      payload: { state, prompt: 'fix the bug', agentType: 'claude', sessionBoundary }
    })
  const agentAlerts = (): (string | undefined)[] =>
    alerts.flatMap((event) =>
      event.type === 'notification' && event.source === 'agent-task-complete'
        ? [event.agentState]
        : []
    )
  return { runtime, server, report, agentAlerts, alerts, addWorkspace }
}
