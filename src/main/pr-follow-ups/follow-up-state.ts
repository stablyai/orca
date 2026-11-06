import type { FollowUpPr, FollowUpTarget, FollowUpView } from '../../shared/pr-follow-ups/contracts'
import { resolvePrFollowUps } from '../../shared/pr-follow-ups/settings'
import type { FollowUpEngineDependencies } from './engine-contract'

const DAY = 24 * 60 * 60 * 1000

export function eligibleFollowUpTargets(
  deps: FollowUpEngineDependencies,
  prKey: string
): FollowUpTarget[] {
  return deps
    .targets()
    .filter((target) => {
      const settings = resolvePrFollowUps(deps.globalSettings(), target.settings)
      return (
        target.prKey === prKey &&
        !target.archived &&
        target.branch === deps.source.latest(prKey)?.headRefName &&
        settings.enabled &&
        settings.ciFailed === 'new-agent'
      )
    })
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt || a.instanceId.localeCompare(b.instanceId))
}

export function followUpPause(
  deps: FollowUpEngineDependencies,
  pr: FollowUpPr,
  limit: number
): Pick<FollowUpView, 'pauseReason' | 'resumesAt'> | undefined {
  if (deps.store.acceptedCount(pr.prKey, pr.generation) >= limit) {
    return { pauseReason: 'generation' }
  }
  const recent = deps.store.recentAcceptedStarts(pr.prKey, (deps.now?.() ?? Date.now()) - DAY)
  if (recent.length >= 6) {
    return { pauseReason: 'daily', resumesAt: recent.at(-6)! + DAY }
  }
  if (pr.consecutiveReadFailures >= 8) {
    return { pauseReason: 'reads' }
  }
  if (pr.consecutiveCommentWakes >= 10) {
    return { pauseReason: 'comments' }
  }
  return undefined
}

export function followUpView(
  deps: FollowUpEngineDependencies,
  prKey: string,
  waitingForWindow: boolean,
  workspaceTarget?: FollowUpTarget
): FollowUpView {
  const target = workspaceTarget ?? eligibleFollowUpTargets(deps, prKey)[0]
  const settings = resolvePrFollowUps(deps.globalSettings(), target?.settings)
  const pr = deps.store.pr(prKey)
  const used = pr ? deps.store.acceptedCount(prKey, pr.generation) : 0
  const base = {
    used,
    limit: settings.maxAutoRunsPerPr,
    stopped: pr?.stoppedAt !== null && pr?.stoppedAt !== undefined
  }
  const offReason = base.stopped
    ? 'stopped'
    : !settings.enabled
      ? 'disabled'
      : settings.ciFailed === 'off'
        ? 'nothing'
        : target && (target.archived || target.branch !== deps.source.latest(prKey)?.headRefName)
          ? 'branch'
          : undefined
  if (!target || !pr || offReason) {
    return { ...base, state: 'off', offReason }
  }
  const latestAction = deps.store.latestAction(prKey)
  const action = latestAction
    ? {
        worktreeId: latestAction.worktreeId,
        sessionId: latestAction.sessionId,
        paneKey: latestAction.paneKey,
        surface: latestAction.surface
      }
    : undefined
  if (latestAction?.status === 'claimed') {
    return { ...base, state: 'starting', workingAgent: latestAction.agent, action }
  }
  if (latestAction?.status === 'unconfirmed') {
    return { ...base, state: 'unconfirmed', action }
  }
  const pause = followUpPause(deps, pr, base.limit)
  if (pause) {
    return { ...base, ...pause, state: 'paused', action }
  }
  const observation = deps.source.latest(prKey)
  const fresh = observation?.failingCheckNames.some((name) => !pr.handled.includes(name))
  if (fresh && target.workingAgent) {
    return { ...base, state: 'waiting', workingAgent: target.workingAgent }
  }
  if (
    fresh &&
    (waitingForWindow ||
      (deps.recipe(target).surface === 'terminal' && !deps.canPublishAgentLaunchTab()))
  ) {
    return { ...base, state: 'waiting-window', workingAgent: deps.recipe(target).agent }
  }
  if (observation?.failingCheckNames.some((name) => pr.baselineNames.includes(name))) {
    return { ...base, state: 'baseline' }
  }
  if (observation?.failingCheckNames.length && !fresh) {
    return { ...base, state: 'handled', action }
  }
  if (
    latestAction?.status === 'accepted' &&
    latestAction.promptUnconfirmed &&
    latestAction.headSha === observation?.headSha &&
    latestAction.sessionEndedAt === undefined
  ) {
    return { ...base, state: 'prompt-unconfirmed', action }
  }
  return {
    ...base,
    state: 'armed',
    action
  }
}
