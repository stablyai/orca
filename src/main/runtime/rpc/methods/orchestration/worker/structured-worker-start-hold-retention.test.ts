// NARROW SCOPE: the hold/clock invariant only. This file proves what `tearDownFailedWorkerStart`
// does to a real `StructuredAgentSessionHolds` and the real 15s release clock, and nothing else.
// It does NOT execute a preamble, an acknowledgement, a worker_done or a release RPC. Those live in
// structured-worker-preamble-dispatch-outcome.test.ts and lifecycle-reconciliation.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { StructuredAgentSessionHolds } from '../../../../../native-chat/agent-session-wire/structured-agent-session-holds'
import { STRUCTURED_AGENT_SESSION_RELEASE_GRACE_MS } from '../../../../../native-chat/agent-session-wire/structured-agent-session-release-clock'
import { tearDownFailedWorkerStart } from './failed-worker-start-teardown'
import {
  discardStructuredWorkerSession,
  releaseStructuredWorkerSession
} from '../../orchestration-structured-worker-session'

// The release mock is not a no-op: it drives the REAL holds object, so whether production code
// calls it is what actually decides whether the real clock arms. A hollow mock would let the old
// behaviour pass this file.
const hooks = vi.hoisted((): { onRelease: ((dispatchId: string) => void) | null } => ({
  onRelease: null
}))

vi.mock('../../orchestration-structured-worker-session', () => ({
  discardStructuredWorkerSession: vi.fn(async () => {}),
  releaseStructuredWorkerSession: vi.fn((dispatchId: string) => {
    hooks.onRelease?.(dispatchId)
  })
}))

const SESSION_ID = 'session-1'
const DISPATCH_ID = 'ctx_1'
const HOLD_ID = `orchestration:dispatch:${DISPATCH_ID}`

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the teardown never reads the runtime; it only forwards it to the two mocked collaborators.
const RUNTIME = {} as OrcaRuntimeService

type Session = {
  holds: StructuredAgentSessionHolds
  evictions: () => number
  setTurnActive: (active: boolean) => void
  hasChild: () => boolean
}

/** A dispatch-held session wired to the real clock. `turnActive` starts FALSE: that is the
 *  delayed/absent projection a preamble awaiting acknowledgement actually presents. */
async function heldSession(): Promise<Session> {
  let hasChild = false
  let turnActive = false
  let evictions = 0
  const holds = new StructuredAgentSessionHolds({
    resume: async () => {
      hasChild = true
    },
    hasProviderChild: () => hasChild,
    isTurnActive: () => turnActive,
    evict: async () => {
      evictions += 1
      hasChild = false
      holds.forget(SESSION_ID)
    }
  })
  await holds.hold(SESSION_ID, HOLD_ID)
  hooks.onRelease = (dispatchId: string) => {
    if (dispatchId === DISPATCH_ID) {
      holds.release(SESSION_ID, HOLD_ID)
    }
  }
  return {
    holds,
    evictions: () => evictions,
    setTurnActive: (active: boolean) => {
      turnActive = active
    },
    hasChild: () => hasChild
  }
}

/** The hold drop itself. worker-stop, worker-release and worker-abandon each reach this call; this
 *  file invokes it directly and makes no claim about which of them ran. */
function dropDispatchHold(): void {
  releaseStructuredWorkerSession(DISPATCH_ID, RUNTIME)
}

async function drainTimers(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
}

const PENDING_PREAMBLE = new OrchestrationError(
  'operation_unknown',
  'The dispatch preamble was submitted but not acknowledged (pending): no reason given.'
)

describe('structured worker start hold retention', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(discardStructuredWorkerSession).mockClear()
    vi.mocked(releaseStructuredWorkerSession).mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
    hooks.onRelease = null
  })

  it('keeps the child past the grace when the start ended non-definitively', async () => {
    const session = await heldSession()

    await tearDownFailedWorkerStart({
      runtime: RUNTIME,
      structuredSession: null,
      dispatchId: DISPATCH_ID,
      error: PENDING_PREAMBLE
    })

    // Four full grace periods with NO active turn to vouch for the session.
    await drainTimers(STRUCTURED_AGENT_SESSION_RELEASE_GRACE_MS * 4)

    expect(session.evictions()).toBe(0)
    expect(session.hasChild()).toBe(true)
    expect(session.holds.isHeld(SESSION_ID)).toBe(true)
    expect(session.holds.isReleasePending(SESSION_ID)).toBe(false)
    expect(releaseStructuredWorkerSession).not.toHaveBeenCalled()

    // Whenever the dispatch is settled, the hold drop is what finally retires the child.
    dropDispatchHold()
    await drainTimers(STRUCTURED_AGENT_SESSION_RELEASE_GRACE_MS + 1)

    expect(session.evictions()).toBe(1)
    expect(session.hasChild()).toBe(false)
    expect(session.holds.isHeld(SESSION_ID)).toBe(false)
    expect(session.holds.isReleasePending(SESSION_ID)).toBe(false)
  })

  // The counterexample the retention exists for: releasing at teardown and trusting the active-turn
  // projection retires the child one grace period later, while the dispatch is still unsettled.
  it('would have lost the child had the hold been dropped at teardown', async () => {
    const session = await heldSession()

    // Exactly what the previous revision did at teardown: drop the hold, keep the child, and let
    // the active-turn projection decide. With no visible turn that is a 15s death sentence.
    releaseStructuredWorkerSession(DISPATCH_ID, RUNTIME)
    await drainTimers(STRUCTURED_AGENT_SESSION_RELEASE_GRACE_MS + 1)

    expect(session.evictions()).toBe(1)
    expect(session.hasChild()).toBe(false)
  })

  it('keeps the child alive across the grace when a turn IS visible, and still needs the hold after it ends', async () => {
    const session = await heldSession()
    session.setTurnActive(true)
    dropDispatchHold()

    await drainTimers(STRUCTURED_AGENT_SESSION_RELEASE_GRACE_MS * 3)
    expect(session.evictions()).toBe(0)

    // The projection is a stay of execution, not a hold: the turn ending re-opens the window.
    session.setTurnActive(false)
    await drainTimers(STRUCTURED_AGENT_SESSION_RELEASE_GRACE_MS + 1)
    expect(session.evictions()).toBe(1)
  })

  it('leaks no hold when a definitive failure tears the start down immediately', async () => {
    const session = await heldSession()

    await tearDownFailedWorkerStart({
      runtime: RUNTIME,
      structuredSession: null,
      dispatchId: DISPATCH_ID,
      error: new OrchestrationError('dispatch_preamble_undelivered', 'not delivered')
    })
    expect(releaseStructuredWorkerSession).toHaveBeenCalledWith(DISPATCH_ID, RUNTIME)

    dropDispatchHold()
    await drainTimers(STRUCTURED_AGENT_SESSION_RELEASE_GRACE_MS + 1)

    expect(session.evictions()).toBe(1)
    expect(session.holds.isHeld(SESSION_ID)).toBe(false)
  })
})
