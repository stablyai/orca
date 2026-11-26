import { describe, expect, it } from 'vitest'
import { ClaudeSlashCommandCatalog } from '../../command-catalog/claude-slash-command-catalog'
import type { ClaudeSession } from '../claude-structured-session-state'
import { createClaudeInitProof } from './claude-structured-init-proof'
import { openClaudeSession } from './claude-structured-session-startup'

describe('openClaudeSession', () => {
  it('fails the start when a refusal landed before the open installed onRefusal', async () => {
    const initProof = createClaudeInitProof()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: openClaudeSession reads only these fields before it returns.
    const session = {
      connection: {},
      options: new Map(),
      reportedOptions: {},
      confirmedOptions: new Set(),
      capabilities: [],
      commands: new ClaudeSlashCommandCatalog(),
      optionMutationSequence: 0,
      reportedModelMutation: 0
    } as unknown as ClaudeSession
    const late: Error[] = []
    initProof.refuse()
    const opened = openClaudeSession({
      session,
      facts: Promise.resolve({
        init: null,
        initProof,
        initialization: {},
        resumesTranscript: false,
        requestTimeoutMs: undefined
      }),
      readSettings: () => new Promise(() => {}),
      isCurrent: () => true,
      diagnose: () => {},
      onLateRefusal: (error) => late.push(error),
      report: () => {}
    })
    await expect(opened).rejects.toThrow('claude provider session expected')
    expect(late.map((error) => error.message)).toEqual(['claude provider session expected'])
  })
})
