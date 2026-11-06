import type { AgentLaunchParams } from '../../shared/rpc-contract/agent-launch-params'
import { canonicalAgentSessionDigest } from '../../shared/agent-session/lifecycle/agent-session-mutation-envelope'
import type {
  FollowUpAction,
  FollowUpObservation,
  FollowUpPr,
  FollowUpTarget
} from '../../shared/pr-follow-ups/contracts'
import { followUpFailureCopy } from './failure'
import { resolvePrFollowUps } from '../../shared/pr-follow-ups/settings'
import type { FollowUpEngineDependencies, FollowUpReceipt } from './engine-contract'
import { eligibleFollowUpTargets, followUpPause, FOLLOW_UP_DAY } from './follow-up-state'

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
  lifecycle: { isDisposed(): boolean; hold(agent: string): void; mutated(): void }
): Promise<void> {
  const { store } = deps
  const paused = (record: FollowUpPr, cap: number) =>
    followUpPause(
      {
        pr: record,
        used: store.acceptedCount(record.prKey, record.generation),
        recentStarts: store.recentAcceptedStarts(
          record.prKey,
          (deps.now?.() ?? Date.now()) - FOLLOW_UP_DAY
        )
      },
      cap
    )
  const names = [
    ...new Set(observation.failingCheckNames.filter((name) => !pr.handled.includes(name)))
  ].sort()
  if (!names.length) {
    return
  }
  const limit = resolvePrFollowUps(deps.globalSettings(), target.settings).maxAutoRunsPerPr
  if (paused(pr, limit) || target.workingAgent) {
    return
  }
  const actionKey = followUpActionKey(pr.prKey, pr.headSha, names)
  const previous = store.action(actionKey)
  if (previous && !['absent', 'failed'].includes(previous.status)) {
    return
  }
  const instanceId = target.instanceId
  const attempt = (previous?.attempt ?? 0) + 1
  const attemptStartedAt = deps.now?.() ?? Date.now()
  const operationId = followUpOperationId(actionKey, attempt, attemptStartedAt)
  let launch: AgentLaunchParams
  let inputs = { key: 'unavailable', agent: previous?.agent ?? 'Agent' }
  let retryKey = JSON.stringify([target.instanceId, target.worktreeId, inputs.key])
  let retryCount = previous?.retryKey === retryKey ? (previous.retryCount ?? 1) : 0
  const allowed = () =>
    retryCount < 3 &&
    (retryCount === 0 ||
      observation.observedAt > (previous?.retryObservedAt ?? previous!.attemptStartedAt))
  let stage: 'recipe' | 'prepare' = 'recipe'
  const admitted = () => {
    retryKey = JSON.stringify([target.instanceId, target.worktreeId, inputs.key])
    retryCount = previous?.retryKey === retryKey ? (previous.retryCount ?? 1) : 0
    return allowed()
  }
  try {
    inputs = deps.launchInputs(target)
    if (!admitted()) {
      return
    }
    const recipe = deps.recipe(target)
    // Background terminals reach a desktop tab only through renderer publication.
    if (recipe.surface === 'terminal' && !deps.canPublishAgentLaunchTab()) {
      lifecycle.hold(recipe.agent)
      return
    }
    stage = 'prepare'
    launch = await deps.prepare(observation, names, target)
    // Prompt/log loading can await network I/O; all launch authority is read again after it.
    const latest = deps.source.latest(pr.prKey)
    const current = eligibleFollowUpTargets(deps, pr.prKey)[0]
    const saved = store.pr(pr.prKey)
    const original = deps.targets(pr.prKey).find((item) => item.worktreeId === target.worktreeId)
    if (
      saved &&
      original &&
      original.instanceId !== instanceId &&
      !eligibleFollowUpTargets(deps, pr.prKey).some(
        (item) => item.instanceId === instanceId || item.worktreeId !== target.worktreeId
      )
    ) {
      saved.needsBaseline = true
      store.savePr(saved)
    }
    if (
      lifecycle.isDisposed() ||
      !latest ||
      !current ||
      !saved ||
      current.instanceId !== instanceId ||
      current.worktreeId !== target.worktreeId ||
      current.workingAgent ||
      saved.stoppedAt !== null ||
      saved.needsBaseline ||
      latest.state === 'closed' ||
      latest.state === 'merged' ||
      !latest.readComplete ||
      !latest.checksFinal ||
      latest.headSha !== observation.headSha ||
      names.some(
        (name) => !latest.failingCheckNames.includes(name) || saved.handled.includes(name)
      ) ||
      paused(saved, resolvePrFollowUps(deps.globalSettings(), current.settings).maxAutoRunsPerPr)
    ) {
      return
    }
    stage = 'recipe'
    if (
      JSON.stringify([current.instanceId, current.worktreeId, deps.launchInputs(current).key]) !==
      retryKey
    ) {
      return
    }
    if (launch.surface === 'terminal' && !deps.canPublishAgentLaunchTab()) {
      lifecycle.hold(launch.agent)
      return
    }
  } catch (error) {
    if (inputs.agent === 'Agent') {
      try {
        inputs.agent = deps.recipe(target).agent
      } catch {
        /* Keep a generic label when both adapters fail. */
      }
    }
    if (!admitted()) {
      return
    }
    store.saveAction({
      actionKey,
      prKey: pr.prKey,
      headSha: pr.headSha,
      failingNames: names,
      mode: 'new-agent',
      worktreeId: target.worktreeId,
      instanceId,
      generation: pr.generation,
      attempt,
      attemptStartedAt,
      operationId,
      status: 'failed',
      agent: inputs.agent,
      failureReason: followUpFailureCopy(inputs.agent, error, stage),
      retryKey,
      retryCount: retryCount + 1,
      retryObservedAt: observation.observedAt
    })
    return
  }
  const action: FollowUpAction = {
    actionKey,
    prKey: pr.prKey,
    headSha: pr.headSha,
    failingNames: names,
    mode: 'new-agent',
    worktreeId: target.worktreeId,
    instanceId: target.instanceId,
    generation: pr.generation,
    attempt,
    attemptStartedAt,
    operationId,
    status: 'claimed',
    retryKey,
    retryCount: retryCount + 1,
    retryObservedAt: observation.observedAt,
    agent: launch.agent
  }
  store.transaction(() => store.saveAction(action))
  lifecycle.mutated()
  let receipt: FollowUpReceipt
  try {
    receipt = await deps.launch({ ...launch, operationId })
  } catch {
    receipt = { status: 'unconfirmed' }
  }
  settleFollowUpReceipt(deps, action, receipt)
  lifecycle.mutated()
  if (action.status === 'accepted') {
    deps.started?.(action)
  }
}

export function settleFollowUpReceipt(
  deps: FollowUpEngineDependencies,
  action: FollowUpAction,
  receipt: FollowUpReceipt
): void {
  deps.store.transaction(() => {
    action.status = receipt.status
    if (receipt.status === 'absent') {
      action.failureReason = receipt.failureReason ?? followUpFailureCopy(action.agent, undefined)
    }
    if (receipt.status === 'accepted') {
      Object.assign(action, receipt.identity)
      action.sessionStartedAt ??= action.attemptStartedAt
    }
    deps.store.saveAction(action)
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
