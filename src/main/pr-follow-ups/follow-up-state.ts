import type {
  FollowUpAction,
  FollowUpObservation,
  FollowUpPr,
  FollowUpTarget,
  FollowUpView
} from '../../shared/pr-follow-ups/contracts'
import type { PrFollowUpsSettings } from '../../shared/pr-follow-ups/settings'
import { resolvePrFollowUps } from '../../shared/pr-follow-ups/settings'
import type { FollowUpEngineDependencies } from './engine-contract'

export const FOLLOW_UP_DAY = 24 * 60 * 60 * 1000

export type FollowUpProjection = {
  pr?: FollowUpPr
  observation?: FollowUpObservation
  latestAction?: FollowUpAction
  pending: FollowUpAction[]
  used: number
  recentStarts: number[]
  waitingForWindow?: string
}

export function eligibleFollowUpTargets(
  deps: FollowUpEngineDependencies,
  prKey: string
): FollowUpTarget[] {
  return deps
    .targets(prKey)
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
  projection: Pick<FollowUpProjection, 'pr' | 'used' | 'recentStarts'>,
  limit: number
): Pick<FollowUpView, 'pauseReason' | 'resumesAt'> | undefined {
  const { pr, used, recentStarts } = projection
  if (used >= limit) {
    return { pauseReason: 'generation' }
  }
  if (recentStarts.length >= 6) {
    return { pauseReason: 'daily', resumesAt: recentStarts.at(-6)! + FOLLOW_UP_DAY }
  }
  if (!pr) {
    return undefined
  }
  if (pr.consecutiveReadFailures >= 8) {
    return { pauseReason: 'reads' }
  }
  return undefined
}

export function followUpView(
  projection: FollowUpProjection,
  globalSettings: PrFollowUpsSettings | undefined,
  target?: FollowUpTarget
): FollowUpView {
  const { pr, observation, latestAction, used, waitingForWindow } = projection
  const settings = resolvePrFollowUps(globalSettings, target?.settings)
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
        : target && (target.archived || target.branch !== observation?.headRefName)
          ? 'branch'
          : undefined
  if (!target || !pr || offReason) {
    return { ...base, state: 'off', offReason }
  }
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
  const pause = followUpPause(projection, base.limit)
  if (pause) {
    return { ...base, ...pause, state: 'paused', action }
  }
  const fresh = observation?.failingCheckNames.some((name) => !pr.handled.includes(name))
  if (fresh && target.workingAgent) {
    return { ...base, state: 'waiting', workingAgent: target.workingAgent }
  }
  if (fresh && waitingForWindow) {
    return { ...base, state: 'waiting-window', workingAgent: waitingForWindow }
  }

  if (
    fresh &&
    latestAction &&
    ['absent', 'failed'].includes(latestAction.status) &&
    latestAction.headSha === observation?.headSha
  ) {
    return {
      ...base,
      state: 'failed',
      workingAgent: latestAction.agent,
      failureReason: latestAction.failureReason
    }
  }
  if (latestAction?.status === 'unconfirmed' && latestAction.headSha === observation?.headSha) {
    return { ...base, state: 'unconfirmed', action }
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
