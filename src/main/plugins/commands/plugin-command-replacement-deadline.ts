import { PluginHostCallError } from '../workers/host-api/plugin-host-call-scope'

type ReplacementRun = {
  pluginKey: string
  action: string
  /** The handler already ran the replaced action itself via `commands.run`. */
  ranAction: boolean
  /** The deadline passed first, so the renderer runs Orca's own action instead. */
  abandoned: boolean
}

const running = new Set<ReplacementRun>()

/**
 * Runs a command that replaces built-in `action`, for a renderer that runs Orca's own action
 * when this rejects. Past `deadline` (epoch ms) it rejects, and the still-running handler may no
 * longer run `action` through `commands.run`, so the person never gets the action twice.
 */
export function runPluginReplacementWithinDeadline(
  pluginKey: string,
  action: string,
  deadline: number,
  run: () => Promise<unknown>
): Promise<unknown> {
  const entry: ReplacementRun = { pluginKey, action, ranAction: false, abandoned: false }
  running.add(entry)
  const work = run().then(
    (value) => {
      running.delete(entry)
      return value
    },
    (error: unknown) => {
      running.delete(entry)
      // Why: the handler already did the action; a fallback now would do it a second time.
      if (entry.ranAction) {
        return undefined
      }
      throw error
    }
  )
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<unknown>((resolve, reject) => {
    timer = setTimeout(
      () => {
        if (entry.ranAction) {
          resolve(undefined)
          return
        }
        entry.abandoned = true
        reject(new Error(`plugin ${pluginKey} did not finish ${action} in time`))
      },
      Math.max(0, deadline - Date.now())
    )
  })
  return Promise.race([work, late]).finally(() => clearTimeout(timer))
}

/** Called before a worker's `commands.run`: refuses an action Orca already ran in its place. */
export function claimPluginReplacedActionRun(pluginKey: string, action: string): void {
  const runs = [...running].filter(
    (entry) => entry.pluginKey === pluginKey && entry.action === action
  )
  if (runs.some((entry) => entry.abandoned)) {
    throw new PluginHostCallError(
      'unavailable',
      `Orca already ran ${action} itself: the replacing command did not finish in time`
    )
  }
  // Why only the oldest: with two presses in flight, one handler's run must not also count as
  // the other's, or a second handler that then fails would get no fallback.
  const owner = runs.find((entry) => !entry.ranAction)
  if (owner) {
    owner.ranAction = true
  }
}
