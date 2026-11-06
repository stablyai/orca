import { describe, expect, it } from 'vitest'
import type { OrchestrationDb } from '../runtime/orchestration/db'
import { openVoiceControlRun, VOICE_CONTROL_HANDLE } from './voice-control-participant'

describe('openVoiceControlRun', () => {
  it('binds a run to the synthetic control handle and exposes its run mailbox', () => {
    const calls: Record<string, unknown>[] = []
    const forgotten: { handle: string; keepRunId: string }[] = []
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the participant calls only createRun and forgetRunCoordinatorHandlesExcept; the rest of the DB surface is fixture weight.
    const db = {
      createRun(params: {
        objective: string
        coordinatorHandle: string | null
        coordinatorPaneKey: string | null
      }) {
        calls.push(params)
        return { id: 'run-42' }
      },
      forgetRunCoordinatorHandlesExcept(handle: string, keepRunId: string) {
        forgotten.push({ handle, keepRunId })
      }
    } as unknown as OrchestrationDb
    const opened = openVoiceControlRun(db)
    expect(calls).toEqual([
      {
        objective: 'Voice control session',
        coordinatorHandle: VOICE_CONTROL_HANDLE,
        coordinatorPaneKey: null
      }
    ])
    expect(forgotten).toEqual([{ handle: VOICE_CONTROL_HANDLE, keepRunId: 'run-42' }])
    expect(opened).toEqual({ runId: 'run-42', mailboxHandle: 'run:run-42' })
  })
})
