import { describe, expect, it, vi } from 'vitest'

import { ClaudeSlashCommandCatalog } from '../../command-catalog/claude-slash-command-catalog'
import type { ClaudeSession } from '../claude-structured-session-state'
import { createClaudeInitProof } from './claude-structured-init-proof'
import { openClaudeSession, type ClaudeInitializeFacts } from './claude-structured-session-startup'

function claudeSessionFake(): ClaudeSession {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the open reads only these fields; the rest of a session belongs to the acquisition.
  return {
    connection: {},
    reportedOptions: {},
    reportedModelMutation: 0,
    optionMutationSequence: 0,
    options: new Map(),
    confirmedOptions: new Set(),
    capabilities: [],
    commands: new ClaudeSlashCommandCatalog(),
    fastModeAtStart: false
  } as unknown as ClaudeSession
}

describe('openClaudeSession', () => {
  it('ends the start when a foreign init was refused before the refusal callback was installed', async () => {
    const initProof = createClaudeInitProof()
    // The initialize answer named no session, so the facts carry no init.
    const facts: ClaudeInitializeFacts = {
      init: null,
      initProof,
      initialization: {},
      resumesTranscript: false,
      requestTimeoutMs: undefined
    }
    // The foreign init lands in the window between the initialize answer and the callback.
    initProof.refuse()
    const refusal = initProof.refused()
    expect(refusal).not.toBeNull()
    const onLateRefusal = vi.fn()

    const opened = openClaudeSession({
      session: claudeSessionFake(),
      facts: Promise.resolve(facts),
      readSettings: async () => ({}),
      isCurrent: () => true,
      diagnose: () => {},
      onLateRefusal,
      report: () => {}
    })

    await expect(opened).rejects.toBe(refusal)
    expect(onLateRefusal).toHaveBeenCalledWith(refusal)
  })
})
