import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useHelperFollowUpCli } from './helper-follow-up-cli.test-support'
import { chooseWorkerFollowUpPlacement } from './worker-follow-up-choice'
import { createStructuredAgentSessionForWorktree } from '../../structured-agent-session-create'
import { findConflictingStructuredAdoption } from '../../../../../native-chat/structured-agent-session-history-adoption'
import type * as SessionCreate from '../../structured-agent-session-create'
import type * as HistoryAdoption from '../../../../../native-chat/structured-agent-session-history-adoption'
import type * as SessionRegistry from '../../../../../native-chat/agent-session-wire/structured-agent-session-registry'
import type * as SessionGate from '../../structured-agent-session-gate'

vi.mock('../../structured-agent-session-create', async (importOriginal) => ({
  ...(await importOriginal<typeof SessionCreate>()),
  createStructuredAgentSessionForWorktree: vi.fn()
}))
vi.mock(
  '../../../../../native-chat/structured-agent-session-history-adoption',
  async (importOriginal) => ({
    ...(await importOriginal<typeof HistoryAdoption>()),
    findConflictingStructuredAdoption: vi.fn(() => null)
  })
)
vi.mock(
  '../../../../../native-chat/agent-session-wire/structured-agent-session-registry',
  async (importOriginal) => ({
    ...(await importOriginal<typeof SessionRegistry>()),
    getStructuredAgentSessionHost: () => ({ deps: { store: { listConversations: () => [] } } })
  })
)

vi.mock('../../structured-agent-session-gate', async (importOriginal) => ({
  ...(await importOriginal<typeof SessionGate>()),
  ensureStructuredHostInstalled: vi.fn(async () => {}),
  requireStructuredHost: vi.fn(() => ({}))
}))

const HELD_CHAT = 'claude_7e3b9d15_2c4a_4f86_a0b1_5c9e2d7f3b64'

describe('a terminal worker Orca closed', () => {
  const f = useHelperFollowUpCli()
  const { h, panes, pair, success } = f
  beforeEach(() => {
    vi.mocked(createStructuredAgentSessionForWorktree).mockReset()
    vi.mocked(findConflictingStructuredAdoption).mockReturnValue(null)
  })

  /** A finished helper whose pane recorded this conversation, then closed by Orca. */
  async function closedHelper(connectionId: string | null = null) {
    const { helper } = await pair()
    vi.mocked(h.runtime.getExactWorkerProviderSession).mockReturnValue({
      paneKey: panes.get('term_helper')!,
      agent: 'claude',
      processIncarnation: 'process:term_helper',
      connectionId,
      providerSession: {
        key: 'session_id',
        id: 'fixture-conversation',
        cwd: '/repo',
        transcriptPath: '/home/u/.claude/projects/repo/renamed.jsonl'
      },
      observedAt: 1
    })
    await success('worker-release', '--dispatch', helper.dispatchId)
    vi.spyOn(h.runtime, 'getLiveTerminalPaneKey').mockReturnValue(null)
    // SAFETY: only the workspace path is read.
    vi.spyOn(h.runtime, 'showManagedTerminalWorkspace').mockResolvedValue({
      path: '/repo'
    } as never)
    const resource = h.db.getWorkerTerminalResourceByOwner(helper.dispatchId)!
    return { helper, resource }
  }

  const open = (handle: string) => h.call('orchestration.partyOpen', { address: handle })

  it('opens its conversation as a chat from its recorded transcript', async () => {
    const { resource } = await closedHelper()
    // SAFETY: only the created session id is read.
    vi.mocked(createStructuredAgentSessionForWorktree).mockResolvedValue({
      ok: true,
      value: { sessionId: 'claude_new' }
    } as never)
    expect(await open(resource.terminal_handle)).toEqual({
      location: { kind: 'chat', sessionId: 'claude_new', worktreeId: resource.worktree_id }
    })
    expect(createStructuredAgentSessionForWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'claude',
        worktree: `id:${resource.worktree_id}`,
        resumeFrom: {
          providerSessionId: 'fixture-conversation',
          cliSource: { workspaceId: resource.worktree_id, paneKey: resource.pane_key }
        },
        structuredAgentCliSourceEvidence: {
          rows: [
            expect.objectContaining({
              paneKey: resource.pane_key,
              providerSession: expect.objectContaining({
                transcriptPath: '/home/u/.claude/projects/repo/renamed.jsonl'
              })
            })
          ]
        },
        atRest: true,
        activate: false
      })
    )
  })

  it('keeps the lookup answer for a conversation recorded over SSH', async () => {
    const { resource } = await closedHelper('ssh-host')
    const looked = await h.call('orchestration.partyLocation', {
      address: resource.terminal_handle
    })
    expect(await open(resource.terminal_handle)).toEqual(looked)
    expect(createStructuredAgentSessionForWorktree).not.toHaveBeenCalled()
  })

  it('fails retryably, never "gone", when the chat may have been created', async () => {
    const { resource } = await closedHelper()
    vi.mocked(createStructuredAgentSessionForWorktree).mockResolvedValue({
      ok: false,
      refusal: {
        code: 'agent_session_operation_unknown',
        details: { reason: 'tabUnconfirmed' },
        message: 'unconfirmed'
      }
    })
    await expect(open(resource.terminal_handle)).rejects.toThrow('agent_session_operation_unknown')
  })

  it('reuses the chat already holding the conversation, and sends follow-ups there', async () => {
    const { helper, resource } = await closedHelper()
    // SAFETY: only the holding chat's ids are read.
    vi.mocked(findConflictingStructuredAdoption).mockReturnValue({
      sessionId: HELD_CHAT,
      workspaceId: 'wt-chat'
    } as never)
    expect(await open(resource.terminal_handle)).toEqual({
      location: { kind: 'chat', sessionId: HELD_CHAT, worktreeId: 'wt-chat' }
    })
    expect(createStructuredAgentSessionForWorktree).not.toHaveBeenCalled()

    const placement = await chooseWorkerFollowUpPlacement(
      h.runtime,
      h.db,
      h.db.getDispatchContextById(helper.dispatchId)!,
      resource,
      { admit: () => {}, requested: () => {} }
    )
    expect(placement).toEqual({
      delivery: 'follow_up',
      worktreeId: 'wt-chat',
      terminal: `orca_session_id:${HELD_CHAT}`
    })
  })
})
