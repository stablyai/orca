import { vi } from 'vitest'
import { AgentSessionJournal } from '../../../agent-session-journal/journal-store'
import * as reducer from '../../../agent-session-journal/projection/journal-reducer'
import type { StructuredAgentSessionHost } from '../structured-agent-session-host'
import { StructuredAgentSessionResumeAdmission } from '../../recovery/structured-agent-session-restart-resume-runner'
import { CALLER, envelope, type hostTestState } from './structured-agent-session-host-test-harness'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestMessage
} from './structured-agent-session-host-test-data'
import { interruptedRestart } from './structured-agent-session-restart-interruption-test-harness'

/** Commit/fold the only upcoming continuation submission, then throw to exercise replay. */
export function throwAfterContinuationAccepted(): void {
  const append = AgentSessionJournal.prototype.appendSubmission
  vi.spyOn(AgentSessionJournal.prototype, 'appendSubmission').mockImplementation(async function (
    this: AgentSessionJournal,
    ...args: Parameters<AgentSessionJournal['appendSubmission']>
  ) {
    await append.apply(this, args)
    throw new Error('the accepted continuation could not be answered')
  })
}

/** Fail the continuation's fold; its row and receipt roll back before any dispatch. */
export function continuationCannotFold(): void {
  const fold = reducer.applyJournalRow
  vi.spyOn(reducer, 'applyJournalRow').mockImplementation((state, row) => {
    if (row.kind === 'submission') {
      throw new Error('the continuation could not fold')
    }
    fold(state, row)
  })
}

/** The agent admits the continuation but no delivery proof arrives; only its later output can settle it. */
export function continuationUnanswered(state: {
  host: StructuredAgentSessionHost
  dispatch: ReturnType<typeof hostTestState>['dispatch']
}): void {
  state.dispatch.mockResolvedValueOnce({ state: 'admitted' })
  const wait = state.host.waitForSendSettlement
  vi.spyOn(state.host, 'waitForSendSettlement').mockImplementation(async (...args) =>
    args[2]?.until === 'handed-over' ? wait(...args) : undefined
  )
}

/** Inject acceptance after reservation so the user wins; userAnswers moves the send outside the attempt. */
export async function supersededRefusal(userAnswers?: 'before' | 'after') {
  const { host, store, acquire, dispatch, root } = await interruptedRestart()
  await host.restartResume.list()
  const body = hostTestMessage('A newer task from another client')
  const answer = () =>
    host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
  const send = host.send
  const writing = vi.spyOn(host, 'send')
  if (!userAnswers) {
    writing.mockImplementationOnce(async (caller, params) => {
      await answer()
      return send(caller, params)
    })
  }
  const admit = StructuredAgentSessionResumeAdmission.prototype.run
  const admitting = vi.spyOn(StructuredAgentSessionResumeAdmission.prototype, 'run')
  if (userAnswers) {
    admitting.mockImplementationOnce(async function (this, ...args) {
      await (userAnswers === 'before' ? answer() : null)
      try {
        return await admit.apply(this, args)
      } finally {
        await (userAnswers === 'after' ? answer() : null)
      }
    })
  }
  try {
    const result = await host.restartResume.continueAfterRestart([SESSION], 'modal')
    return { host, store, acquire, dispatch, root, result }
  } finally {
    writing.mockRestore()
    admitting.mockRestore()
  }
}
