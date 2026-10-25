// Older clients may leave unsupported approvals actionable; gate new subject kinds by client capability.

import { expect, it } from 'vitest'
import { AGENT_JOURNAL_APPROVAL_SUBJECT_KINDS } from '../../../shared/agent-session-journal-schemas'

const SUBJECT_KINDS_EVERY_CLIENT_DRAWS = ['plan']
// Future capability-gated kinds belong here (STA-9262).
const CAPABILITY_GATED_SUBJECT_KINDS: string[] = []

it('adds no approval subject kind without a client-capability gate', () => {
  const ungated = [...AGENT_JOURNAL_APPROVAL_SUBJECT_KINDS]
    .filter((kind) => !CAPABILITY_GATED_SUBJECT_KINDS.includes(kind))
    .sort()
  expect(
    ungated,
    'New approval subject kinds need a client-capability gate first: older clients would let ' +
      'users approve it blind. See https://linear.app/stably/issue/STA-9262'
  ).toEqual(SUBJECT_KINDS_EVERY_CLIENT_DRAWS)
})
