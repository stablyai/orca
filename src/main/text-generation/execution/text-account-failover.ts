import { isSubscriptionQuotaRefusal } from '../failures/subscription-quota-refusal'
import {
  CANCELED_GENERATION_RESULT,
  clearLocalGenerationCancelToken,
  localGenerationLaneKey,
  setLocalGenerationCancelToken
} from './source-control-generation-lanes'
import type {
  InternalTextGenerationResult,
  LocalGenerationTarget,
  TextAccountFailover,
  TextGenerationOperation
} from '../source-control-text-generation-types'

/** How many other saved accounts one request may try after its first refusal. */
export const MAX_TEXT_ACCOUNT_FAILOVERS = 2

/** Runs one request, then reruns it unchanged on other saved accounts while each is refused for
 *  subscription quota. The caller receives exactly one result. */
export async function runWithTextAccountFailover(input: {
  agentId: string
  target: LocalGenerationTarget
  failover: TextAccountFailover
  operation: TextGenerationOperation
  shouldExecute?: () => boolean
  run: (
    target: LocalGenerationTarget,
    shouldExecute: () => boolean
  ) => Promise<InternalTextGenerationResult>
}): Promise<InternalTextGenerationResult> {
  const { failover, operation, target } = input
  // With shouldExecute set, an attempt settles only once its process has exited, so none overlap.
  const shouldExecute = input.shouldExecute ?? (() => true)
  const lane = localGenerationLaneKey(operation, target.cwd, target.laneId)
  const tried = new Set(failover.initialAccountId ? [failover.initialAccountId] : [])
  let result = await input.run(target, shouldExecute)
  for (let attempt = 0; attempt < MAX_TEXT_ACCOUNT_FAILOVERS; attempt += 1) {
    if (
      result.success ||
      result.canceled ||
      !isSubscriptionQuotaRefusal(input.agentId, result.failureOutput)
    ) {
      return result
    }
    // No process owns the lane between attempts, so Stop lands here.
    let stopped = false
    const stop = Promise.withResolvers<null>()
    const cancel = (): void => {
      stopped = true
      stop.resolve(null)
    }
    setLocalGenerationCancelToken(lane, cancel)
    let next: Awaited<ReturnType<TextAccountFailover['next']>>
    try {
      next = await Promise.race([failover.next(tried).catch(() => null), stop.promise])
    } finally {
      clearLocalGenerationCancelToken(lane, cancel)
    }
    if (stopped || shouldExecute() === false) {
      return { ...CANCELED_GENERATION_RESULT }
    }
    if (!next) {
      return result
    }
    tried.add(next.accountId)
    console.warn('[text-generation] Retrying on another saved account after a subscription limit', {
      agentId: input.agentId,
      operation
    })
    result = await input.run({ ...target, env: next.env }, shouldExecute)
  }
  return result
}
