import { describe, expect, it } from 'vitest'
import { journalSubmission, ORCA_SEND, PERSON_SEND } from './bot-journal-submission.test-fixture'
import { personSendsOf } from './bot-typed-in-orca'

// Hardcoded: `orca:q` is the journal item a send with client id `q` echoes as.
describe('a send read for the item it became', () => {
  it('is the earliest send naming it, by provider id or client key alike', () => {
    const adopted = { clientMessageId: 'a', providerItemId: 'orca:q' }
    const keyed = { clientMessageId: 'q' }
    expect(
      personSendsOf([
        journalSubmission({ ...adopted, ...ORCA_SEND }),
        journalSubmission({ ...keyed, ...PERSON_SEND })
      ])('orca:q')
    ).toBe(false)
    expect(
      personSendsOf([
        journalSubmission({ ...adopted, ...PERSON_SEND, queuedMessageId: 'card-1' }),
        journalSubmission({ ...keyed, ...PERSON_SEND })
      ])('orca:q')
    ).toBe(false)
    expect(
      personSendsOf([
        journalSubmission({ ...adopted, ...PERSON_SEND }),
        journalSubmission({ ...keyed, ...PERSON_SEND, queuedMessageId: 'card-1' })
      ])('orca:q')
    ).toBe(true)
  })

  it('takes an empty provider id as an id', () => {
    const sends = personSendsOf([
      journalSubmission({ clientMessageId: 'a', providerItemId: '', ...PERSON_SEND }),
      journalSubmission({ clientMessageId: 'b', providerItemId: '', ...ORCA_SEND })
    ])
    expect(sends('')).toBe(true)
  })
})
