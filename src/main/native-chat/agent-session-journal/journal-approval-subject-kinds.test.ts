// Every approval subject kind the journal schema knows, against the kinds every supported client
// draws. A client from before unknown subjects were refused leaves Approve live for a kind it cannot
// draw, so a new kind ships only behind a client capability that withholds it from such clients.

import { expect, it } from 'vitest'
import { AGENT_JOURNAL_APPROVAL_SUBJECT_KINDS } from '../../../shared/agent-session-journal-schemas'

/** Drawn by every supported client. */
const SUBJECT_KINDS_EVERY_CLIENT_DRAWS = ['plan']
/** Kinds the host withholds from clients without the capability; none exists yet (STA-9262). */
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
