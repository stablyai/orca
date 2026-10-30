import { describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../shared/agent-status-types'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import { renewRuntimeMobileAgentStatusFromPtyTitle } from './runtime-mobile-agent-status-projection'
import { projectRuntimeMobileSessionTabs } from './runtime-mobile-session-projection'
import type { RuntimeMobileSessionProjectionHost } from './runtime-mobile-session-projection-contract'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'

const MESSAGE = '좌→우 가로 파이프라인으로 다시 그렸습니다'

function workingStatus(overrides: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  return {
    state: 'working',
    prompt: 'stale task',
    updatedAt: 1_700_000_000_000,
    stateStartedAt: 1_699_999_999_000,
    agentType: 'claude',
    paneKey: 'tab:leaf',
    terminalTitle: 'claude working',
    lastAssistantMessage: MESSAGE,
    interrupted: false,
    stateHistory: [],
    ...overrides
  }
}

describe('mobile completion status projection', () => {
  it.each([false, true])(
    'keeps the completion subtitle and interrupted verdict %s under a shell title',
    (interrupted) => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: renew reads only the title clock and status fields this stub sets.
      const pty = {
        lastOscTitle: 'bash',
        lastOscTitleEpochMs: 1_700_000_000_500,
        lastAgentStatus: 'idle',
        lastAgentStatusStartedAtEpochMs: 1_700_000_000_500,
        lastAgentStatusRichInvalidatedAtEpochMs: 1_700_000_000_400
      } as RuntimePtyWorktreeRecord

      expect(
        renewRuntimeMobileAgentStatusFromPtyTitle(
          workingStatus({ state: 'done', interrupted }),
          pty
        )
      ).toMatchObject({
        state: 'done',
        prompt: '',
        agentType: 'claude',
        lastAssistantMessage: MESSAGE,
        interrupted
      })
    }
  )

  it.each(['working', 'permission'] as const)(
    'does not carry an interrupted verdict into a new %s title',
    (titleState) => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: renewal reads only the title clock and status fields provided here.
      const pty = {
        lastOscTitle: 'Claude Code',
        lastOscTitleEpochMs: 1_700_000_000_500,
        lastAgentStatus: titleState,
        lastAgentStatusStartedAtEpochMs: 1_700_000_000_500,
        lastAgentStatusRichInvalidatedAtEpochMs: 1_700_000_000_400
      } as RuntimePtyWorktreeRecord

      const renewed = renewRuntimeMobileAgentStatusFromPtyTitle(
        workingStatus({
          state: 'done',
          interrupted: true,
          lastAssistantMessageIsToolOutput: false
        }),
        pty
      )
      expect(renewed?.state).toBe(titleState === 'working' ? 'working' : 'blocked')
      expect(renewed?.interrupted).toBeUndefined()
      expect(renewed?.lastAssistantMessage).toBeUndefined()
      expect(renewed?.lastAssistantMessageIsToolOutput).toBeUndefined()
    }
  )

  it.each([
    { titleState: 'working', sourceState: 'done', toolOutput: false },
    { titleState: 'working', sourceState: 'done', toolOutput: true },
    { titleState: 'idle', sourceState: 'done', toolOutput: true },
    { titleState: 'idle', sourceState: 'working', toolOutput: false }
  ] as const)(
    'keeps the reply only for a completed turn under a completed title $titleState/$sourceState/$toolOutput',
    ({ titleState, sourceState, toolOutput }) => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: renewal reads only the title clock and status fields provided here.
      const pty = {
        lastOscTitle: 'Claude Code',
        lastOscTitleEpochMs: 1_700_000_000_500,
        lastAgentStatus: titleState,
        lastAgentStatusStartedAtEpochMs: 1_700_000_000_500,
        lastAgentStatusRichInvalidatedAtEpochMs: 1_700_000_000_400
      } as RuntimePtyWorktreeRecord

      const renewed = renewRuntimeMobileAgentStatusFromPtyTitle(
        workingStatus({ state: sourceState, lastAssistantMessageIsToolOutput: toolOutput }),
        pty
      )
      expect(renewed?.state).toBe(titleState === 'working' ? 'working' : 'done')
      if (titleState === 'working' || sourceState === 'working') {
        expect(renewed?.lastAssistantMessage).toBeUndefined()
        expect(renewed?.lastAssistantMessageIsToolOutput).toBeUndefined()
      } else {
        expect(renewed).toMatchObject({
          lastAssistantMessage: MESSAGE,
          lastAssistantMessageIsToolOutput: toolOutput
        })
      }
    }
  )

  it.each([
    { sourceState: 'done', toolOutput: false },
    { sourceState: 'done', toolOutput: true },
    { sourceState: 'working', toolOutput: false }
  ] as const)(
    'keeps only a completed reply when a shell leaf title demotes the mobile projection $sourceState/$toolOutput',
    ({ sourceState, toolOutput }) => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stub sets the pty fields the title clock and handle publication read.
      const pty = {
        ptyId: 'live-pty',
        connected: true,
        incarnationId: 'live-incarnation',
        lastOscTitleEpochMs: null,
        lastAgentStatus: null,
        lastAgentStatusStartedAtEpochMs: null,
        lastAgentStatusRichInvalidatedAtEpochMs: null
      } as RuntimePtyWorktreeRecord
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stub implements every host member this terminal projection path calls.
      const host = {
        tabs: new Map(),
        leaves: new Map([
          [
            'leaf',
            {
              ptyId: pty.ptyId,
              connected: true,
              paneTitle: 'bash',
              paneTitleUpdatedAt: 1
            }
          ]
        ]),
        ptysById: new Map([[pty.ptyId, pty]]),
        getPtyAvailability: () => null,
        getLiveBrowserTabs: () => new Map(),
        getProviderSessionRows: () => [],
        getProviderSessionSnapshot: () => [],
        getLeafKey: () => 'leaf',
        findPty: () => pty,
        getRetainedStatus: () => null,
        getTrackedTitle: () => null,
        getTitleDisplayClear: () => null,
        issuePtyHandle: vi.fn(() => 'handle'),
        recordPty: vi.fn(() => pty),
        buildPtyStatus: () => ({}),
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
            id: 'tab::leaf',
            parentTabId: 'tab',
            leafId: 'leaf',
            title: 'bash',
            agentStatus: workingStatus({
              state: sourceState,
              interrupted: true,
              lastAssistantMessageIsToolOutput: toolOutput
            }),
            isActive: true
          }
        ]
      } as RuntimeMobileSessionTabsSnapshot

      const tab = projectRuntimeMobileSessionTabs(snapshot, host).tabs[0]
      const agentStatus = tab?.type === 'terminal' ? tab.agentStatus : undefined
      expect(agentStatus).toMatchObject({ state: 'done', agentType: 'claude', prompt: '' })
      expect(agentStatus?.terminalTitle).toBeUndefined()
      if (sourceState === 'done') {
        expect(agentStatus).toMatchObject({
          lastAssistantMessage: MESSAGE,
          lastAssistantMessageIsToolOutput: toolOutput,
          interrupted: true
        })
      } else {
        expect(agentStatus?.lastAssistantMessage).toBeUndefined()
        expect(agentStatus?.lastAssistantMessageIsToolOutput).toBeUndefined()
        expect(agentStatus?.interrupted).toBeUndefined()
      }
    }
  )
})
