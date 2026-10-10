// Stands in for `journal-unsent-send-hold` in suites that make a Stop's withdrawal (its `cancelled`
// hold) fail or hang; every other hold runs as is. A suite installs it with
// `vi.mock('../agent-session-journal/journal-unsent-send-hold', () => import(<this file>))`.

import { vi } from 'vitest'
import type * as UnsentSendHold from '../agent-session-journal/journal-unsent-send-hold'

type HoldModule = typeof UnsentSendHold
type Settled = ReturnType<HoldModule['holdUnsentSends']>

const actual = await vi.importActual<HoldModule>(
  '../agent-session-journal/journal-unsent-send-hold'
)

/** While `run` is set, it answers the Stop's withdrawal; `settle` runs the real one. */
export const stopWithdrawal: { run?: (settle: () => Settled) => Settled } = {}

export const { unsentSendKeptAsCard, isUnansweredHandedOverSubmission } = actual

export function holdUnsentSends(...args: Parameters<HoldModule['holdUnsentSends']>): Settled {
  const { run } = stopWithdrawal
  return args[1].hold.cause === 'cancelled' && run
    ? run(() => actual.holdUnsentSends(...args))
    : actual.holdUnsentSends(...args)
}
