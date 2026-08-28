import type { CommandHandler } from '../../dispatch'
import { printResult } from '../../format'
import { getOptionalStringFlag } from '../../flags'
import { RuntimeClientError } from '../../runtime-client'

type StateResult = {
  identity: {
    outcomeId: string | null
    runId: string | null
    taskId: string | null
    dispatchId: string | null
    legacyUnbound: boolean
  }
  lifecycle: Record<string, string | null>
  lastMeaningfulEvent: { messageId: string; wakeReason: string | null; subject: string } | null
  liveness: { verdict: string; activity: string; reason: string; expired: boolean }
  route: { routeKey: string | null; certification: string; failureReason: string | null }
  completionGate: { required: boolean; satisfied: boolean; blockingGate: string | null }
  nextLegalActions: string[]
}

/** B10 — one bounded call. No worker-list dump, no transcript archaeology, no
 *  chain of status/list/show, and the legal next actions come back as data so a
 *  recovering caller never has to discover shell syntax. */
export const ORCHESTRATION_STATE_HANDLER: Record<string, CommandHandler> = {
  'orchestration state': async ({ flags, client, json }) => {
    const selector = {
      outcome: getOptionalStringFlag(flags, 'outcome'),
      run: getOptionalStringFlag(flags, 'run'),
      task: getOptionalStringFlag(flags, 'task'),
      dispatch: getOptionalStringFlag(flags, 'dispatch')
    }
    if (!selector.outcome && !selector.run && !selector.task && !selector.dispatch) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Select at least one target: --outcome, --run, --task, or --dispatch.'
      )
    }
    const result = await client.call<StateResult>('orchestration.state', selector)
    printResult(result, json, (value) =>
      [
        `outcome=${value.identity.outcomeId ?? '<none>'} run=${value.identity.runId ?? '<none>'}`,
        `task=${value.identity.taskId ?? '<none>'} dispatch=${value.identity.dispatchId ?? '<none>'}`,
        `liveness=${value.liveness.verdict}/${value.liveness.activity} (${value.liveness.reason})`,
        `route=${value.route.routeKey ?? '<none>'} certification=${value.route.certification}`,
        `completionGate required=${value.completionGate.required} satisfied=${value.completionGate.satisfied} blocking=${value.completionGate.blockingGate ?? '<none>'}`,
        `lastEvent=${value.lastMeaningfulEvent?.wakeReason ?? '<none>'} ${value.lastMeaningfulEvent?.subject ?? ''}`.trim(),
        `next=${value.nextLegalActions.join(',')}`
      ].join('\n')
    )
  }
}
