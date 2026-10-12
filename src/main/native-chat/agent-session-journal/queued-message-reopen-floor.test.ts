// Where the reopen mark of what an earlier host process left starts.

import { describe, expect, it } from 'vitest'
import { queuedMessageReopenMarkStart } from './queued-message-reopen-floor'

const CURRENT = 'epoch-2'

describe('the reopen mark after a restart', () => {
  it("starts at this handle's floor when it is in the current epoch", () => {
    expect(
      queuedMessageReopenMarkStart(
        { epoch: CURRENT, sequence: 9 },
        { epoch: CURRENT, sequence: 4 },
        CURRENT
      )
    ).toBe(9)
  })

  it('starts just past where this process first opened the chat when no floor is set', () => {
    expect(queuedMessageReopenMarkStart(null, { epoch: CURRENT, sequence: 4 }, CURRENT)).toBe(5)
  })

  it('is not written from a floor an older epoch left, so it never holds cards queued since', () => {
    // A failed startup mark, then a rewind that moved the epoch: both cursors are the old epoch's.
    expect(
      queuedMessageReopenMarkStart(
        { epoch: 'epoch-1', sequence: 9 },
        { epoch: 'epoch-1', sequence: 8 },
        CURRENT
      )
    ).toBeNull()
  })
})
