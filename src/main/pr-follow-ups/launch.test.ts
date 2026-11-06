import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { AgentSessionOperationOutcome } from '../../shared/agent-session/lifecycle/agent-session-operation-ledger'
import { getDefaultSettings } from '../../shared/constants'
import type { Repo } from '../../shared/repo-types'
import type { FollowUpObservation, FollowUpTarget } from '../../shared/pr-follow-ups/contracts'
import { prepareFollowUpLaunch, recoverFollowUpLaunch } from './launch'

vi.mock('../runtime/rpc/methods/agent-launch', () => ({ launchAgentOnHost: vi.fn() }))

function runtime(outcome?: AgentSessionOperationOutcome): OrcaRuntimeService {
  return {
    openAgentSessionRecordStore: async () => ({
      getOperationRow: () => (outcome ? { outcome } : null)
    }),
    getTerminalPtyIdForHandle: () => 'pty-1'
  } as unknown as OrcaRuntimeService
}

describe('follow-up launch receipts', () => {
  it('preserves terminal identity and an uncertain prompt after durable acceptance', async () => {
    expect(
      await recoverFollowUpLaunch(
        runtime({
          status: 'succeeded',
          sessionId: '',
          launch: {
            outcome: { kind: 'terminal', handle: 'terminal-1', paneKey: 'tab:leaf' },
            worktreeId: 'workspace-1',
            receipt: {
              mode: 'terminal',
              preferred: 'terminal',
              reason: 'requested',
              detail: 'Terminal'
            },
            prompt: { delivery: 'submit', outcome: 'unconfirmed' }
          }
        }),
        { operationId: 'operation-1', agent: 'codex' }
      )
    ).toEqual({
      status: 'accepted',
      identity: {
        surface: 'terminal',
        terminalHandle: 'terminal-1',
        paneKey: 'tab:leaf',
        terminalPtyId: 'pty-1',
        promptUnconfirmed: true
      }
    })
  })

  it('distinguishes an effect-free refusal, a user-closed tab, and missing or expired proof', async () => {
    expect(
      await recoverFollowUpLaunch(runtime({ status: 'failed', code: 'agent_launch_tab_closed' }), {
        operationId: 'op',
        agent: 'codex'
      })
    ).toEqual({ status: 'declined' })
    expect(
      await recoverFollowUpLaunch(
        runtime({
          status: 'failed',
          code: 'agent_launch_surface_unavailable',
          message: 'Raw adapter details are not user copy'
        }),
        { operationId: 'op', agent: 'codex' }
      )
    ).toEqual({
      status: 'absent',
      failureReason:
        'Codex could not start in the selected surface. Choose an available surface in Source Control AI settings, then use Fix checks.'
    })
    expect(
      await recoverFollowUpLaunch(
        runtime({ status: 'failed', code: 'agent_session_operation_expired' }),
        { operationId: 'op', agent: 'codex' }
      )
    ).toEqual({ status: 'unconfirmed' })
    expect(await recoverFollowUpLaunch(runtime(), { operationId: 'op', agent: 'codex' })).toEqual({
      status: 'unconfirmed'
    })
    const unreadable = runtime()
    unreadable.openAgentSessionRecordStore = async () => {
      throw new Error('Receipt store unavailable')
    }
    expect(await recoverFollowUpLaunch(unreadable, { operationId: 'op', agent: 'codex' })).toEqual({
      status: 'unconfirmed'
    })
  })
})

it('uses the saved Fix checks recipe and falls back from preferred chat when the host cannot create it', async () => {
  const settings = getDefaultSettings('/tmp')
  settings.defaultTuiAgent = 'claude'
  settings.nativeChatProviders = { codex: false }
  settings.sourceControlAi!.actions = {
    fixChecks: {
      agentId: 'codex',
      surface: 'chat',
      commandInputTemplate: 'Fix carefully: {basePrompt}',
      agentArgs: '--quiet',
      launchPreferences: {
        agentId: 'codex',
        modelSelection: {
          base: 'default',
          model: { agentId: 'codex', value: 'gpt-5.5' }
        }
      }
    }
  }
  const support = vi.fn().mockResolvedValue({ supported: true })
  const args = {
    runtime: { getStructuredAgentSessionCreateSupport: support } as unknown as OrcaRuntimeService,
    observation: { headSha: 'head-123' } as FollowUpObservation,
    names: ['unit'],
    target: { worktreeId: 'workspace-1' } as FollowUpTarget,
    settings,
    repo: { id: 'repo-1', path: '/tmp/repo' } as Repo,
    pr: { number: 7, title: 'Fix checkout', url: 'https://github.com/a/b/pull/7' },
    checks: [
      { name: 'unit', status: 'completed' as const, conclusion: 'failure' as const, url: null }
    ],
    loadDetails: async () => null
  }
  const chat = await prepareFollowUpLaunch(args)
  expect(chat).toMatchObject({
    agent: 'codex',
    surface: 'chat',
    presentation: 'background',
    sessionOptions: { model: 'gpt-5.5' }
  })
  support.mockResolvedValue({ supported: false, reason: 'chat-program' })
  expect(await prepareFollowUpLaunch(args)).toMatchObject({
    agent: 'codex',
    surface: 'terminal',
    sessionOptions: { model: 'gpt-5.5' }
  })
})
