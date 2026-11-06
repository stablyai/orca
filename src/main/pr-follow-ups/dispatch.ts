import { canonicalAgentSessionDigest } from '../../shared/agent-session/lifecycle/agent-session-mutation-envelope'
import type {
  FollowUpAction,
  FollowUpActionMetadata,
  FollowUpObservation,
  FollowUpPr,
  FollowUpTarget
} from '../../shared/pr-follow-ups/contracts'
import { resolvePrFollowUps } from '../../shared/pr-follow-ups/settings'
import type { FollowUpEngineDependencies, FollowUpReceipt } from './engine-contract'
import { eligibleFollowUpTargets, followUpPause } from './follow-up-state'

export function followUpActionKey(prKey: string, headSha: string, names: string[]): string {
  return JSON.stringify([prKey, headSha, [...new Set(names)].sort()])
}

export function followUpOperationId(actionKey: string, attempt: number, startedAt: number): string {
  const digest = canonicalAgentSessionDigest({
    domain: 'pr-follow-ups:fresh-launch',
    actionKey,
    attempt
  }).slice(0, 32)
  return `${startedAt}-${digest}`
}

export async function dispatchFollowUp(
  deps: FollowUpEngineDependencies,
  observation: FollowUpObservation,
  pr: FollowUpPr,
  target: FollowUpTarget,
  lifecycle: { isDisposed(): boolean; hold(agent: string): void }
): Promise<void> {
  const { store } = deps
  const names = [
    ...new Set(observation.failingCheckNames.filter((name) => !pr.handled.includes(name)))
  ].sort()
  if (!names.length) {
    return
  }
  const actions = store.metadata(pr.prKey)
  if (actions.some((action) => action.status === 'claimed' || action.status === 'unconfirmed')) {
    return
  }
  const limit = resolvePrFollowUps(deps.globalSettings(), target.settings).maxAutoRunsPerPr
  if (followUpPause(deps, pr, limit) || target.workingAgent) {
    return
  }
  const actionKey = followUpActionKey(pr.prKey, pr.headSha, names)
  const previous = actions.find((action) => action.actionKey === actionKey)
  if (previous && previous.status !== 'absent') {
    return
  }
  const instanceId = target.instanceId
  // Background terminals reach a desktop tab only through renderer publication.
  if (deps.recipe(target).surface === 'terminal' && !deps.canPublishAgentLaunchTab()) {
    lifecycle.hold(deps.recipe(target).agent)
    return
  }
  const launch = await deps.prepare(observation, names, target)
  // Prompt/log loading can await network I/O; all launch authority is read again after it.
  const latest = deps.source.latest(pr.prKey)
  const current = eligibleFollowUpTargets(deps, pr.prKey)[0]
  const saved = store.pr(pr.prKey)
  if (
    lifecycle.isDisposed() ||
    !latest ||
    !current ||
    !saved ||
    current.instanceId !== instanceId ||
    current.workingAgent ||
    saved.stoppedAt !== null ||
    saved.needsBaseline ||
    latest.state !== 'open' ||
    !latest.readComplete ||
    !latest.checksFinal ||
    latest.headSha !== observation.headSha ||
    names.some(
      (name) => !latest.failingCheckNames.includes(name) || saved.handled.includes(name)
    ) ||
    followUpPause(
      deps,
      saved,
      resolvePrFollowUps(deps.globalSettings(), current.settings).maxAutoRunsPerPr
    )
  ) {
    return
  }
  if (launch.surface === 'terminal' && !deps.canPublishAgentLaunchTab()) {
    lifecycle.hold(launch.agent)
    return
  }
  const attempt = (previous?.attempt ?? 0) + 1
  const attemptStartedAt = deps.now?.() ?? Date.now()
  const operationId = followUpOperationId(actionKey, attempt, attemptStartedAt)
  const action: FollowUpAction = {
    actionKey,
    prKey: pr.prKey,
    headSha: pr.headSha,
    failingNames: names,
    mode: 'new-agent',
    worktreeId: target.worktreeId,
    instanceId: target.instanceId,
    generation: saved.generation,
    attempt,
    attemptStartedAt,
    operationId,
    status: 'claimed',
    launch: { ...launch, operationId }
  }
  store.transaction(() => store.saveAction(action))
  let receipt: FollowUpReceipt
  try {
    receipt = await deps.launch(action.launch)
  } catch {
    receipt = { status: 'unconfirmed' }
  }
  settleFollowUpReceipt(deps, action, receipt)
  if (action.status === 'accepted') {
    deps.started?.(action)
  }
}

export function settleFollowUpReceipt(
  deps: FollowUpEngineDependencies,
  action: FollowUpAction | FollowUpActionMetadata,
  receipt: FollowUpReceipt
): void {
  deps.store.transaction(() => {
    action.status = receipt.status
    if (receipt.status === 'accepted') {
      Object.assign(action, receipt.identity)
      action.sessionStartedAt ??= action.attemptStartedAt
    }
    if ('launch' in action) {
      deps.store.saveAction(action)
    } else {
      deps.store.saveActionMetadata(action)
    }
    if (receipt.status === 'absent') {
      const pr = deps.store.pr(action.prKey)
      if (pr?.headSha === action.headSha) {
        pr.handled = pr.handled.filter((name) => !action.failingNames.includes(name))
        deps.store.savePr(pr)
      }
    } else {
      const pr = deps.store.pr(action.prKey)
      if (pr && pr.headSha === action.headSha) {
        pr.handled = [...new Set([...pr.handled, ...action.failingNames])]
        deps.store.savePr(pr)
      }
    }
  })
}
