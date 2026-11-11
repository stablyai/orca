import { describe, expect, it, vi } from 'vitest'
import type { AutomationRun } from '../../shared/automations/history/automation-run'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { sendToReusableSession } from './automation-terminal-session-reuse'

const { deliver } = vi.hoisted(() => ({ deliver: vi.fn(async () => true) }))
vi.mock('../runtime/rpc/methods/agent-launch/agent-launch-terminal-prompt', () => ({
  deliverTerminalAgentLaunchPrompt: deliver
}))

const PANE = 'original-tab:11111111-1111-4111-8111-111111111111'

function reuse({ restoreFails = false, deliveryFails = false } = {}) {
  deliver.mockResolvedValue(!deliveryFails)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the reuse path reads only the listed runtime ports.
  const runtime = {
    getAgentStatusRowsForPane: () => [],
    getTerminalHandleForPaneKey: () => null,
    listRecordedAgentSessions: async () => ({
      sessions: [
        {
          agent: 'codex',
          paneKey: PANE,
          providerSession: { key: 'session_id', id: 'original-conversation' }
        }
      ]
    }),
    resumeRecordedAgentSession: async () => {
      if (restoreFails) {
        throw new Error('original conversation is held elsewhere')
      }
      return { handle: 'term_resumed', paneKey: PANE, ptyId: 'new-pty', disposition: 'resumed' }
    }
  } as unknown as OrcaRuntimeService
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the run's routing and terminal fields participate in selection.
  const previous = {
    id: 'previous',
    automationId: 'auto',
    workspaceId: 'workspace',
    sessionKind: 'terminal',
    terminalSessionId: 'original-tab',
    terminalPaneKey: PANE,
    terminalPtyId: null,
    status: 'completed',
    createdAt: 1
  } as AutomationRun
  return sendToReusableSession(
    runtime,
    {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: reuse reads only the automation identity, agent and workspace.
      automation: {
        id: 'auto',
        agentId: 'codex',
        workspaceId: 'workspace'
      } as Parameters<typeof sendToReusableSession>[1]['automation'],
      run: { id: 'current', trigger: 'scheduled' },
      runs: [previous],
      text: 'follow up',
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: reuse reads only the resolved repository identity, host and path.
      target: { ok: true, repo: { id: 'repo', path: '/repo' } } as Parameters<
        typeof sendToReusableSession
      >[1]['target']
    },
    'Workspace',
    'local'
  )
}

describe('an automation whose original conversation slept', () => {
  it('returns the original tab with the resumed terminal identity', async () => {
    expect(await reuse()).toEqual({
      workspaceId: 'workspace',
      workspaceDisplayName: 'Workspace',
      terminalHandle: 'term_resumed',
      terminalSessionId: 'original-tab',
      terminalPaneKey: PANE,
      terminalPtyId: 'new-pty'
    })
  })

  it('fails a refused restore instead of inviting a fresh launch', async () => {
    await expect(reuse({ restoreFails: true })).rejects.toThrow('held elsewhere')
  })

  it('retains the restored target when prompt delivery is unconfirmed', async () => {
    await expect(reuse({ deliveryFails: true })).rejects.toMatchObject({
      target: { terminalPaneKey: PANE, terminalPtyId: 'new-pty' }
    })
  })
})
