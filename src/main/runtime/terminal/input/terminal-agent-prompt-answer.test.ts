import { describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { WriteSettlement } from '../../../../shared/terminal/pty/lifecycle/pty-write-settlement'
import type { RuntimeTerminalSend } from '../../../../shared/runtime-terminal-send-contract'
import { TerminalAgentPromptAnswers } from './terminal-agent-prompt-answer'

const PANE = 'tab-1:11111111-1111-4111-8111-111111111111'
const target = { paneKey: PANE, agent: 'claude', answerable: true }

function approvalRow(stateStartedAt = 10): AgentStatusIpcPayload {
  return {
    state: 'waiting',
    prompt: '',
    agentType: 'claude',
    paneKey: PANE,
    connectionId: null,
    receivedAt: stateStartedAt,
    stateStartedAt,
    interactivePrompt: JSON.stringify({ approval: { tool: 'Bash', summary: 'ls' } })
  }
}

function harness() {
  const state: {
    row: AgentStatusIpcPayload | null
    incarnation: string
    settlement: WriteSettlement
    beforeWrite?: () => void
  } = { row: approvalRow(), incarnation: 'inc-1', settlement: { outcome: 'accepted' } }
  const keys: string[] = []
  const runtime = {
    getTerminalHandleForPaneKey: (paneKey: string) => (paneKey === PANE ? 'term-1' : null),
    getTerminalPromptRequestBinding: () => ({
      ptyId: 'pty-1',
      processIncarnation: state.incarnation,
      generation: 1
    }),
    sendTerminal: vi.fn(
      async (
        handle: string,
        action: { text?: string; enter?: boolean },
        options: {
          beforeWrite?: (ptyId: string) => void | Promise<void>
          reserveWrite?: (ptyId: string) => void
        }
      ): Promise<RuntimeTerminalSend> => {
        state.beforeWrite?.()
        await options.beforeWrite?.('pty-1')
        options.reserveWrite?.('pty-1')
        expect(action.enter).toBe(false)
        if (state.settlement.outcome === 'accepted') {
          keys.push(action.text ?? '')
        }
        return {
          handle,
          accepted: state.settlement.outcome === 'accepted',
          bytesWritten: 1,
          writeSettlement: state.settlement
        }
      }
    )
  }
  const answers = new TerminalAgentPromptAnswers(() => state.row)
  const signal = new AbortController().signal
  const answer = (promptId: string, optionId = 'allow_once') =>
    answers.answer(runtime, target, { promptId, optionId, signal })
  return { state, keys, runtime, answers, answer }
}

describe('TerminalAgentPromptAnswers', () => {
  it('allows only one concurrent answer to claim the prompt', async () => {
    const h = harness()
    const { promptId } = h.answers.pending(h.runtime, target)!
    await expect(Promise.all([h.answer(promptId), h.answer(promptId)])).resolves.toEqual([
      { outcome: 'accepted' },
      { outcome: 'refused', reason: 'prompt_not_pending' }
    ])
    expect(h.keys).toEqual(['1'])
  })

  it('does not unclaim another answer when a concurrent fence rejects without an error', async () => {
    const h = harness()
    const { promptId } = h.answers.pending(h.runtime, target)!
    const accepted = h.answer(promptId)
    const refused = h.answers.answer(h.runtime, target, {
      promptId,
      optionId: 'reject_once',
      signal: new AbortController().signal,
      beforeWrite: () => Promise.reject()
    })
    await expect(accepted).resolves.toEqual({ outcome: 'accepted' })
    await expect(refused).resolves.toEqual({ outcome: 'refused', reason: 'agent_not_reachable' })
    expect(h.answers.pending(h.runtime, target)).toBeNull()
    expect(h.keys).toEqual(['1'])
  })

  it('keeps the claim when the writer throws after the fence passes', async () => {
    const h = harness()
    const { promptId } = h.answers.pending(h.runtime, target)!
    h.runtime.sendTerminal.mockImplementationOnce(async (_handle, _action, options) => {
      await options.beforeWrite?.('pty-1')
      options.reserveWrite?.('pty-1')
      throw new Error('transport_lost')
    })
    await expect(h.answer(promptId)).resolves.toEqual({ outcome: 'unknown' })
    expect(h.answers.pending(h.runtime, target)).toBeNull()
  })

  it('refuses when the prompt or the process changes between the read and the write', async () => {
    const h = harness()
    const first = h.answers.pending(h.runtime, target)!.promptId
    h.state.beforeWrite = () => {
      h.state.incarnation = 'inc-2'
    }
    await expect(h.answer(first)).resolves.toMatchObject({ reason: 'prompt_not_pending' })
    h.state.incarnation = 'inc-1'
    h.state.beforeWrite = () => {
      h.state.row = approvalRow(30)
    }
    h.state.row = approvalRow()
    await expect(h.answer(first)).resolves.toMatchObject({ reason: 'prompt_not_pending' })
    expect(h.keys).toEqual([])
  })

  it('keeps a write the transport refused answerable, and an unprovable one answered', async () => {
    const h = harness()
    const { promptId } = h.answers.pending(h.runtime, target)!
    h.state.settlement = { outcome: 'refused', reason: 'endpoint_disconnected' }
    await expect(h.answer(promptId)).resolves.toMatchObject({ reason: 'agent_not_reachable' })
    h.state.settlement = {
      outcome: 'unverifiable',
      reason: 'provider_threw_after_handoff',
      bytesHandedToTransport: true
    }
    await expect(h.answer(promptId)).resolves.toEqual({ outcome: 'unknown' })
    await expect(h.answer(promptId)).resolves.toMatchObject({ reason: 'prompt_not_pending' })
  })

  it('honors an older writer’s refusal without a settlement', async () => {
    const h = harness()
    const { promptId } = h.answers.pending(h.runtime, target)!
    h.runtime.sendTerminal.mockResolvedValueOnce({
      handle: 'term-1',
      accepted: false,
      bytesWritten: 0
    })
    await expect(h.answer(promptId)).resolves.toEqual({
      outcome: 'refused',
      reason: 'agent_not_reachable'
    })
    expect(h.answers.pending(h.runtime, target)?.promptId).toBe(promptId)
  })
})
