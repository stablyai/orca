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
  const accepted = deps.store.actions(pr.prKey).filter((action) => action.status === 'accepted')
  if (accepted.filter((action) => action.generation === pr.generation).length >= limit) {
    return { pauseReason: 'generation' }
  }
  const recent = accepted
    .map((action) => action.sessionStartedAt ?? action.attemptStartedAt)
    .filter((startedAt) => startedAt > (deps.now?.() ?? Date.now()) - DAY)
    .sort((a, b) => a - b)
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
  waitingForWindow: boolean
): FollowUpView {
  const target = eligibleFollowUpTargets(deps, prKey)[0]
  const settings = resolvePrFollowUps(deps.globalSettings(), target?.settings)
  const pr = deps.store.pr(prKey)
  const actions = deps.store.actions(prKey)
  const used = actions.filter(
    (action) => action.status === 'accepted' && action.generation === pr?.generation
  ).length
  const base = {
    used,
    limit: settings.maxAutoRunsPerPr,
    stopped: pr?.stoppedAt !== null && pr?.stoppedAt !== undefined
  }
  if (!target || !pr || base.stopped) {
    return { ...base, state: 'off' }
  }
  const latestAction = actions
    .filter((action) => action.status !== 'absent')
    .sort((a, b) => b.attemptStartedAt - a.attemptStartedAt)[0]
  const action = latestAction
    ? {
        worktreeId: latestAction.worktreeId,
        sessionId: latestAction.sessionId,
        paneKey: latestAction.paneKey,
        surface: latestAction.surface
      }
    : undefined
  if (latestAction?.status === 'unconfirmed' || latestAction?.status === 'claimed') {
    return { ...base, state: 'unconfirmed', action }
  }
  if (latestAction?.status === 'accepted' && latestAction.promptUnconfirmed) {
    return { ...base, state: 'prompt-unconfirmed', action }
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
  return {
    ...base,
    state: observation?.failingCheckNames.length && !fresh ? 'handled' : 'armed',
    action
  }
}
