import { expect, it } from 'vitest'
import { STORE_FLOOR } from './fixtures/store-floor-release'
import {
  journalStorageVocabulary,
  newVocabularyRoots
} from './journal-storage-vocabulary.test-fixture'

// The floor refuses a saved chat holding a key or union tag its strict storage doesn't declare, so
// every one this build declares beyond the floor is listed with why writing it is acceptable.
it(`keeps chat storage within what ${STORE_FLOOR.release} declares, or reviewed`, () => {
  const reviewed = STORE_FLOOR.reviewedJournalVocabulary.flatMap((group) => group.roots).sort()
  expect(
    newVocabularyRoots(journalStorageVocabulary(), STORE_FLOOR.journalStorageVocabulary)
  ).toEqual(reviewed)
})
