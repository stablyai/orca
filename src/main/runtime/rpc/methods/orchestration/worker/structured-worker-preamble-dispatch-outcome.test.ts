// The seam the startup defect lives on: what the REAL preamble send does with each dispatchState,
// and which of those outcomes the teardown is then allowed to treat as definitive.
//
// Nothing is mocked here. The error codes asserted below are the exact values
// `failed-worker-start-teardown` branches on, so this file and
// `structured-worker-start-hold-retention.test.ts` meet at `OrchestrationError.code`.

import { describe, expect, it, vi } from 'vitest'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import type { StructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/structured-agent-session-host'
import { sendStructuredWorkerPreamble } from '../../orchestration-structured-worker-session'

const SESSION_ID = 'session-1'
const DISPATCH_ID = 'ctx_1'
const PREAMBLE = 'You are working inside Orca, a multi-agent IDE.'

type Submission = { dispatchState: string; reason?: string | null }

/** Narrowing readers: the caught value is `unknown`, and reading it by assertion would report the
 *  field of a type the error may not even have. */
function errorCode(error: unknown): string | undefined {
  return error instanceof OrchestrationError ? error.code : undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function hostReturning(
  submission: Submission | null,
  options: { fence?: number | undefined; refusal?: string } = {}
): { host: StructuredAgentSessionHost; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn(async () =>
    options.refusal
      ? { ok: false as const, refusal: { message: options.refusal } }
      : { ok: true as const, value: { submission } }
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the preamble path reads only `deps.store.getRecord(...).lease.runtimeFence` and `send`.
  const host = {
    deps: {
      store: {
        getRecord: () =>
          options.fence === undefined ? undefined : { lease: { runtimeFence: options.fence } }
      }
    },
    send
  } as unknown as StructuredAgentSessionHost
  return { host, send }
}

async function deliver(
  submission: Submission | null,
  options: { fence?: number | undefined; refusal?: string } = { fence: 7 }
): Promise<{ error: unknown; sends: number }> {
  const { host, send } = hostReturning(submission, options)
  let error: unknown
  try {
    await sendStructuredWorkerPreamble({
      host,
      sessionId: SESSION_ID,
      dispatchId: DISPATCH_ID,
      preamble: PREAMBLE
    })
  } catch (caught) {
    error = caught
  }
  return { error, sends: send.mock.calls.length }
}

describe('structured worker preamble dispatch outcome', () => {
  it('returns quietly once the submission is acknowledged', async () => {
    const { error, sends } = await deliver({ dispatchState: 'accepted' }, { fence: 7 })

    expect(error).toBeUndefined()
    expect(sends).toBe(1)
  })

  // CX1/SF4. `pending` is the state that killed the structured route: the preamble IS delivered and
  // only its acknowledgement is outstanding, so the code must be the non-definitive one.
  it('reports a pending submission as operation_unknown after exactly one delivery', async () => {
    const { error, sends } = await deliver({ dispatchState: 'pending', reason: null }, { fence: 7 })

    expect(error).toBeInstanceOf(OrchestrationError)
    expect(errorCode(error)).toBe('operation_unknown')
    // The delivery happened. Any retry of it would be a SECOND delivery under the same id.
    expect(sends).toBe(1)
  })

  it('reports a rejected submission as the definitive dispatch_preamble_undelivered', async () => {
    const { error } = await deliver(
      { dispatchState: 'rejected', reason: 'provider refused' },
      { fence: 7 }
    )

    expect(error).toBeInstanceOf(OrchestrationError)
    expect(errorCode(error)).toBe('dispatch_preamble_undelivered')
  })

  it('never sends when the session has no durable record to dispatch into', async () => {
    const { error, sends } = await deliver({ dispatchState: 'accepted' }, { fence: undefined })

    expect(error).toBeInstanceOf(Error)
    expect(errorMessage(error)).toContain('no durable record')
    expect(sends).toBe(0)
  })

  it('surfaces a refusal from the host as a plain failure, not a dispatch doubt', async () => {
    const { error } = await deliver(null, { fence: 7, refusal: 'session is not attached' })

    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(OrchestrationError)
    expect(errorMessage(error)).toContain('refused')
  })
})
