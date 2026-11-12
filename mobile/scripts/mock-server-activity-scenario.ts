import type {
  RuntimeMobileSessionTabsResult,
  RuntimeWorktreeAgentRow,
  RuntimeWorktreePsSummary
} from '../../src/shared/runtime-types'

export const MOCK_ACTIVITY_VIEW = process.env.MOCK_ACTIVITY_VIEW === '1'
const LEAF = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'
const SCENARIO_STARTED_AT = Date.now()
const names = [
  'Approve deployment',
  'Answer engineering question',
  'Review PR 2135',
  'Check issue 515',
  'Upgrade Autopilot',
  'Map ShinePhone features',
  'Investigate retrieval',
  'Watch deployment',
  'Fix session navigation',
  'Audit knowledge evidence',
  'Review workflow',
  'Build Android APK',
  'Validate support replay',
  'Update account settings'
]

export function activityScenarioAgents(now = Date.now()): RuntimeWorktreeAgentRow[] {
  return names.map((name, i) => ({
    paneKey: `activity-tab-${i}:${LEAF}`,
    parentPaneKey: null,
    state: i === 0 ? 'blocked' : i === 1 ? 'waiting' : i < 8 ? 'working' : 'done',
    ...(i === 7 ? { workingMode: 'monitoring' as const } : {}),
    agentType: 'codex',
    prompt: name,
    taskTitle: name,
    displayName: name,
    conversationName: name,
    lastAssistantMessage:
      i < 2
        ? 'Your input is needed to continue.'
        : i < 8
          ? `Working on ${name.toLowerCase()}.`
          : `${name} completed. Ready for your review.`,
    toolName: null,
    toolInput: null,
    interrupted: false,
    structuredHostOwned: true,
    stateStartedAt: SCENARIO_STARTED_AT - (i + 1) * 60_000,
    updatedAt: now
  }))
}

export function withActivityScenario(
  worktrees: RuntimeWorktreePsSummary[]
): RuntimeWorktreePsSummary[] {
  const first = worktrees[0]
  return !first
    ? []
    : [
        {
          ...first,
          repo: 'SolarSupportAI',
          branch: 'main',
          displayName: 'main',
          isMainWorktree: true,
          hasHostSidebarActivity: true,
          hasAttachedPty: true,
          liveTerminalCount: 14,
          agents: activityScenarioAgents()
        }
      ]
}

export function activityScenarioTabs(
  worktree: string,
  publicationEpoch: string
): RuntimeMobileSessionTabsResult {
  const agents = activityScenarioAgents()
  return {
    worktree,
    publicationEpoch,
    snapshotVersion: 1,
    activeGroupId: 'activity-group',
    activeTabId: `activity-tab-0::${LEAF}`,
    activeTabType: 'terminal',
    tabGroups: [
      {
        id: 'activity-group',
        activeTabId: 'activity-tab-0',
        tabOrder: agents.map((_, i) => `activity-tab-${i}`),
        recentTabIds: ['activity-tab-0']
      }
    ],
    tabs: agents.map((agent, i) => ({
      type: 'terminal' as const,
      id: `activity-tab-${i}::${LEAF}`,
      parentTabId: `activity-tab-${i}`,
      leafId: LEAF,
      title: names[i],
      status: 'ready' as const,
      terminal: `activity-terminal-${i}`,
      isActive: i === 0,
      agentStatus: {
        paneKey: agent.paneKey,
        agentType: 'codex' as const,
        state: agent.state,
        prompt: agent.prompt,
        updatedAt: agent.updatedAt,
        stateStartedAt: agent.stateStartedAt,
        stateHistory: [],
        lastAssistantMessage: agent.lastAssistantMessage ?? undefined
      }
    }))
  }
}
