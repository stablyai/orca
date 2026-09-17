import { describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import { recoverResolvedPromptSessionOptions } from './structured-agent-session-prompt-option-recovery'

function resolvedOptions(
  expectedRevision: number,
  values: Readonly<Record<string, string>>,
  expectedValues: Readonly<Record<string, string>> = { permissionMode: 'plan' }
): AgentJournalRenderItem {
  return {
    itemId: 'orca:approval-1',
    revision: 2,
    sequence: 2,
    observedAt: 2,
    body: {
      kind: 'approval',
      title: 'Approve?',
      detail: null,
      options: [{ id: 'allow', label: 'Allow' }],
      resolution: {
        state: 'resolved',
        selectedOptionId: 'allow',
        resolvedBy: 'client-1',
        resolvedAt: 2,
        sessionOptions: { expectedRevision, expectedValues, values }
      }
    }
  }
}

describe('resolved prompt option recovery', () => {
  it('replays an option effect when no later option write superseded it', () => {
    const recovered = recoverResolvedPromptSessionOptions(
      { options: { permissionMode: 'plan' }, optionsRevision: 4 },
      [resolvedOptions(4, { permissionMode: 'acceptEdits' })]
    )

    expect(recovered).toEqual({ permissionMode: 'acceptEdits' })
  })

  it('preserves a later explicit option write', () => {
    const recovered = recoverResolvedPromptSessionOptions(
      { options: { permissionMode: 'plan' }, optionsRevision: 5 },
      [resolvedOptions(4, { permissionMode: 'acceptEdits' })]
    )

    expect(recovered).toEqual({ permissionMode: 'plan' })
  })

  it('preserves an older host write that could not advance the revision', () => {
    const recovered = recoverResolvedPromptSessionOptions(
      {
        options: { permissionMode: 'plan', model: 'newer-model' },
        optionsRevision: 4
      },
      [resolvedOptions(4, { permissionMode: 'acceptEdits', model: 'older-model' })]
    )

    expect(recovered).toEqual({ permissionMode: 'plan', model: 'newer-model' })
  })
})
