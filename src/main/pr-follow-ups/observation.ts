import type { FollowUpObservation } from '../../shared/pr-follow-ups/contracts'
import type { FollowUpEngineContext } from './engine-contract'
import { eligibleFollowUpTargets } from './follow-up-state'
import { dispatchFollowUp } from './dispatch'

export async function evaluateFollowUpObservation(
  deps: FollowUpEngineContext,
  observation: FollowUpObservation,
  cached: boolean,
  lifecycle: {
    clearHold(): void
    isDisposed(): boolean
    hold(agent: string): void
    mutated(): void
  }
): Promise<void> {
  const { store } = deps
  lifecycle.clearHold()
  let pr = store.pr(observation.prKey)
  const targets = eligibleFollowUpTargets(deps, observation.prKey)
  if (
    !pr &&
    (!targets.length || observation.state === 'closed' || observation.state === 'merged')
  ) {
    return
  }
  pr ??= {
    prKey: observation.prKey,
    baselineAt: null,
    needsBaseline: true,
    headSha: observation.headSha,
    lastSeenAt: 0,
    handled: [],
    baselineNames: [],
    generation: 0,
    stoppedAt: null,
    consecutiveReadFailures: 0,
    pendingRead: false,
    state: observation.state
  }
  if (observation.observedAt < (pr.lastReadAt ?? pr.lastSeenAt)) {
    return
  }
  for (const target of deps.targets(pr.prKey)) {
    store.bind(pr.prKey, target.instanceId)
  }
  pr.state = observation.state
  if (
    !targets.length ||
    pr.stoppedAt !== null ||
    observation.state === 'closed' ||
    observation.state === 'merged'
  ) {
    pr.needsBaseline = true
    store.savePr(pr)
    store.retire(pr)
    return
  }
  // Activation waits for a completed reader observation, not its older cached snapshot.
  if (pr.needsBaseline && cached) {
    store.savePr(pr)
    return
  }
  if (!observation.readComplete) {
    // Reconciliations of a held observation are not additional failed reads.
    if (!cached && observation.observedAt > (pr.lastReadAt ?? pr.lastSeenAt)) {
      pr.consecutiveReadFailures += 1
    }
    pr.pendingRead = true
    if (!cached) {
      pr.lastReadAt = observation.observedAt
    }
    store.savePr(pr)
    return
  }
  pr.pendingRead = false
  if (pr.consecutiveReadFailures < 8) {
    pr.consecutiveReadFailures = 0
  }
  if (pr.headSha !== observation.headSha) {
    const attributed = deps.source
      .pullRequestActionsFor?.(pr.prKey)
      .some(
        (push) =>
          push.kind === 'pushed' &&
          push.headSha === observation.headSha &&
          store.pushAttributed(pr.prKey, push.chatId)
      )
    const overlapped = store.workingOverlap(pr.prKey, pr.lastSeenAt, observation.observedAt)
    if (!attributed && !overlapped) {
      pr.generation += 1
    }
    pr.headSha = observation.headSha
    pr.handled = []
    pr.baselineNames = []
  }
  if (!cached) {
    pr.lastSeenAt = observation.observedAt
    pr.lastReadAt = observation.observedAt
  }
  if (pr.needsBaseline) {
    pr.baselineAt = observation.observedAt
    pr.needsBaseline = false
    pr.handled = [...new Set([...pr.handled, ...observation.failingCheckNames])]
    pr.baselineNames = [...observation.failingCheckNames]
    store.savePr(pr)
    return
  }
  store.savePr(pr)
  if (!observation.checksFinal) {
    return
  }
  lifecycle.mutated()
  await dispatchFollowUp(deps, observation, pr, targets[0]!, lifecycle)
}
