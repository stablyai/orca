// An orchestration worker for a registered agent (Grok) opens as a terminal worker, as before Grok
// had a structured chat: the structured worker factory creates Claude and Codex only, so a
// structured verdict for Grok would fail the start. Other launches still open Grok as a chat.

import { describe, expect, it } from 'vitest'
import { decideAgentLaunchMode } from '../../../agent-launch/agent-launch-mode'
import {
  decideWorkerStartMode,
  resolveWorkerStartModeOnHost
} from './orchestration-worker-start-mode'
import { createStructuredWorkerSessionForWorktree } from './orchestration/worker/worker-topology'

const STRUCTURED_PREFERENCE = {
  experimentalNativeChat: true
} as const

describe('a Grok worker and the structured-chat setting', () => {
  it('starts as a terminal worker while the setting is on; Claude starts structured', async () => {
    const grok = decideWorkerStartMode({
      params: { agent: 'grok' },
      settings: STRUCTURED_PREFERENCE
    })
    expect(grok).toMatchObject({ mode: 'terminal', reason: 'agent_without_structured_session' })
    const host = { getStructuredAgentSessionCreateSupport: async () => ({ supported: true }) }
    expect(await resolveWorkerStartModeOnHost(host, grok, 'wt-1', 'grok')).toMatchObject({
      mode: 'terminal'
    })
    expect(
      decideWorkerStartMode({ params: { agent: 'claude' }, settings: STRUCTURED_PREFERENCE })
    ).toMatchObject({ mode: 'structured', reason: 'user_default' })
  })

  it('still opens Grok as a structured chat for other launches', () => {
    expect(
      decideAgentLaunchMode({ placement: { agent: 'grok' }, settings: STRUCTURED_PREFERENCE })
    ).toMatchObject({ mode: 'structured' })
  })

  it('would fail a structured Grok worker: the factory creates Claude and Codex only', async () => {
    await expect(
      createStructuredWorkerSessionForWorktree({
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the factory refuses the agent before it reads the runtime.
        runtime: {} as never,
        worktreeId: 'wt-1',
        agent: 'grok',
        dispatchId: 'd-1',
        effects: []
      })
    ).rejects.toThrow(/Structured workers support claude and codex/)
  })

  it('starts as a terminal agent while the setting is off, as Claude does', () => {
    for (const agent of ['grok', 'claude']) {
      expect(
        decideWorkerStartMode({
          params: { agent },
          settings: { experimentalNativeChat: false }
        })
      ).toMatchObject({ mode: 'terminal', preferred: 'terminal', reason: 'user_default' })
    }
  })
})
