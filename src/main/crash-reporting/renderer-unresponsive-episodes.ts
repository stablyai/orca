export type RendererEpisodeOutcome = 'recovered' | 'process_gone' | 'abandoned'
export type RendererEpisode = { episodeId: number; startedAtMs: number }
/** Mutable app-session budget shared by every renderer episode machine. */
export type RendererEpisodeSessionBudget = { count: number }

export type RendererEpisodeMachine = {
  onUnresponsive: (nowMs?: number) => RendererEpisode | null
  onResponsive: (
    nowMs?: number
  ) => { episodeId: number; outcome: 'recovered'; durationMs: number } | null
  onProcessGone: (
    nowMs?: number
  ) => { episodeId: number; outcome: 'process_gone'; durationMs: number } | null
  onAbandoned: (
    nowMs?: number
  ) => { episodeId: number; outcome: 'abandoned'; durationMs: number } | null
  current: () => RendererEpisode | null
}

export function createRendererUnresponsiveEpisodeMachine(
  options: {
    now?: () => number
    maxEpisodes?: number
    sessionBudget?: RendererEpisodeSessionBudget
    isSuppressed?: () => boolean
    nextEpisodeId?: () => number
  } = {}
): RendererEpisodeMachine {
  const now = options.now ?? (() => Date.now())
  const max = options.maxEpisodes ?? 5
  const sessionBudget = options.sessionBudget
  let current: RendererEpisode | null = null
  let count = 0
  const close = <T extends RendererEpisodeOutcome>(
    outcome: T,
    at: number
  ): {
    episodeId: number
    outcome: T
    durationMs: number
  } | null => {
    if (!current) {
      return null
    }
    const result = {
      episodeId: current.episodeId,
      outcome,
      durationMs: Math.max(0, at - current.startedAtMs)
    } as const
    current = null
    return result
  }
  return {
    onUnresponsive: (at = now()) => {
      if (
        current ||
        (sessionBudget ? sessionBudget.count : count) >= max ||
        options.isSuppressed?.()
      ) {
        return null
      }
      if (sessionBudget) {
        sessionBudget.count += 1
      } else {
        count += 1
      }
      current = { episodeId: options.nextEpisodeId?.() ?? at, startedAtMs: at }
      return current
    },
    onResponsive: (at = now()) => close('recovered', at),
    onProcessGone: (at = now()) => close('process_gone', at),
    onAbandoned: (at = now()) => close('abandoned', at),
    current: () => current
  }
}

export function shouldSuppressRendererUnresponsive(options: {
  isDev: boolean
  isDevToolsOpened: boolean
  debuggerAttached: boolean
}): boolean {
  return (
    (options.isDev && process.env.ORCA_FREEZE_EPISODES_IN_DEV !== '1') ||
    options.isDevToolsOpened ||
    options.debuggerAttached
  )
}
