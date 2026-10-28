import { describe, expect, it } from 'vitest'
import type { AgentStatusIpcPayload } from '../../../shared/agent-status-ipc-payload'
import type { AutomationRun } from '../../../shared/automations-types'
import {
  collectWslMoveGateInputs,
  listWslMovePanes,
  type WslMoveGateFactSources,
  type WslMoveLiveTerminal
} from './wsl-move-gate-facts'
import { assessWslMoveTerminals } from './wsl-move-terminal-gate'

const WT = 'repo-1::\\\\wsl.localhost\\Ubuntu\\home\\dev\\app'
const pane = (n: number) => `tab-${n}:${n}${n}${n}${n}${n}${n}${n}${n}-1111-4111-8111-111111111111`
const scope = { workspaceIds: [WT], workspaceKeys: new Set([WT]) }

const terminal = (n: number, extra: Partial<WslMoveLiveTerminal> = {}): WslMoveLiveTerminal => ({
  ptyId: `pty-${n}`,
  workspaceId: WT,
  paneKey: pane(n),
  wslDistro: 'Ubuntu',
  foregroundAgent: null,
  ...extra
})

const row = (paneKey: string, extra: Partial<AgentStatusIpcPayload>): AgentStatusIpcPayload =>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The gate reads only the fields set here.
  ({
    paneKey,
    state: 'done',
    prompt: '',
    agentType: 'claude',
    connectionId: null,
    receivedAt: 1,
    stateStartedAt: 1,
    ...extra
  }) as AgentStatusIpcPayload

function sources(overrides: Partial<WslMoveGateFactSources> = {}): WslMoveGateFactSources {
  return {
    listTerminals: () => [],
    inspect: async () => ({
      foregroundProcess: 'bash',
      hasChildProcesses: false,
      childProcessEvidence: 'no-children'
    }),
    agentRows: () => [],
    scrollbackBytes: async () => 10,
    automationRuns: () => [],
    dispatches: () => [],
    ...overrides
  }
}

describe('collectWslMoveGateInputs', () => {
  it('passes idle shells and an idle resumable agent that owns its pane', async () => {
    const inputs = await collectWslMoveGateInputs(
      sources({
        listTerminals: () => [terminal(1), terminal(2, { foregroundAgent: 'claude' })],
        inspect: async (ptyId) =>
          ptyId === 'pty-2'
            ? {
                foregroundProcess: 'claude',
                hasChildProcesses: true,
                childProcessEvidence: 'children'
              }
            : {
                foregroundProcess: 'bash',
                hasChildProcesses: false,
                childProcessEvidence: 'no-children'
              },
        agentRows: (paneKey) =>
          paneKey === pane(2)
            ? [
                row(pane(2), {
                  providerSession: { key: 'session_id', id: '0f0e0d0c-1111-4111-8111-111111111111' }
                })
              ]
            : []
      }),
      scope
    )
    expect(assessWslMoveTerminals(inputs).verdict).toBe('ready')
  })

  it('blocks a working agent, a dev server, an unanswered probe and a paneless terminal', async () => {
    const inputs = await collectWslMoveGateInputs(
      sources({
        listTerminals: () => [
          terminal(1, { foregroundAgent: 'claude' }),
          terminal(2),
          terminal(3),
          terminal(4, { paneKey: null })
        ],
        inspect: async (ptyId) => {
          if (ptyId === 'pty-3') {
            throw new Error('daemon gone')
          }
          return {
            foregroundProcess: 'node',
            hasChildProcesses: true,
            childProcessEvidence: 'children'
          }
        },
        // The newest row wins over an older finished one.
        agentRows: (paneKey) =>
          paneKey === pane(1)
            ? [row(pane(1), { state: 'done' }), row(pane(1), { state: 'working', receivedAt: 2 })]
            : []
      }),
      scope
    )
    const verdict = assessWslMoveTerminals(inputs)
    expect(verdict).toEqual({
      verdict: 'blocked',
      blockers: [
        { kind: 'agent-working', ids: [pane(1)], actions: ['wait', 'end', 'skip-project'] },
        { kind: 'process-running', ids: [pane(2)], actions: ['end', 'skip-project'] },
        { kind: 'unverifiable', ids: [pane(3), 'pty:pty-4'], actions: ['wait', 'skip-project'] }
      ]
    })
  })

  it('never lets a stale agent row vouch for another foreground process', async () => {
    const inputs = await collectWslMoveGateInputs(
      sources({
        listTerminals: () => [terminal(1, { foregroundAgent: null })],
        inspect: async () => ({
          foregroundProcess: 'vim',
          hasChildProcesses: true,
          childProcessEvidence: 'children'
        }),
        agentRows: () => [
          row(pane(1), {
            providerSession: { key: 'session_id', id: '0f0e0d0c-1111-4111-8111-111111111111' }
          })
        ]
      }),
      scope
    )
    expect(assessWslMoveTerminals(inputs)).toMatchObject({
      verdict: 'blocked',
      blockers: [{ kind: 'process-running' }]
    })
  })

  it('takes running automation runs and live dispatches in scope only', async () => {
    const run = (id: string, status: AutomationRun['status'], workspaceId: string | null) =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The gate reads only id, status and workspaceId.
      ({ id, status, workspaceId }) as AutomationRun
    const inputs = await collectWslMoveGateInputs(
      sources({
        automationRuns: () => [
          run('running', 'dispatched', WT),
          run('done', 'completed', WT),
          run('elsewhere', 'pending', 'other::C:\\src')
        ],
        dispatches: () => [
          { dispatchId: 'live', worktreeId: WT, state: 'ready' },
          { dispatchId: 'settled', worktreeId: WT, state: 'stopped' },
          { dispatchId: 'other', worktreeId: 'other::C:\\src', state: 'ready' }
        ]
      }),
      scope
    )
    expect(inputs.runningAutomationRunIds).toEqual(['running'])
    expect(inputs.activeDispatchIds).toEqual(['live'])
  })

  it('reads an unreadable scrollback size as unknown, which blocks', async () => {
    const inputs = await collectWslMoveGateInputs(
      sources({
        listTerminals: () => [terminal(1)],
        scrollbackBytes: async () => {
          throw new Error('EIO')
        }
      }),
      scope
    )
    expect(assessWslMoveTerminals(inputs)).toMatchObject({
      verdict: 'blocked',
      blockers: [{ kind: 'unverifiable' }]
    })
  })
})

describe('listWslMovePanes', () => {
  it('lists each pane with its session, skipping terminals with no pane', () => {
    expect(
      listWslMovePanes(
        sources({ listTerminals: () => [terminal(1), terminal(2, { paneKey: null })] }),
        scope
      )
    ).toEqual([{ paneKey: pane(1), sessionId: 'pty-1', wslDistro: 'Ubuntu' }])
  })
})
