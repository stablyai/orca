import type { GlobalSettings } from '../shared/global-settings-types'

type IsolationSettings =
  | Partial<Pick<GlobalSettings, 'isolateExternalAgentConfig'>>
  | null
  | undefined

let readIsolationSettings: (() => IsolationSettings) | null = null

// Why a live reader instead of a cached flag: trust presets and credential sync run deep in launch
// paths that never receive settings, and a toggle must take effect for the very next launch.
export function configureAgentConfigIsolation(reader: () => IsolationSettings): void {
  readIsolationSettings = reader
}

export function isAgentConfigIsolatedInSettings(settings: IsolationSettings): boolean {
  return settings?.isolateExternalAgentConfig === true
}

/**
 * True when the user asked Orca never to write agent CLI config, trust files or credentials
 * outside Orca's own data directories. Unconfigured (CLI process, tests) means not isolated,
 * which keeps today's behavior for every caller that never opted in.
 * Checked at each writer's entry: a toggle mid-call lets that one call finish.
 */
export function isExternalAgentConfigIsolated(): boolean {
  if (!readIsolationSettings) {
    return false
  }
  try {
    return isAgentConfigIsolatedInSettings(readIsolationSettings())
  } catch {
    // Why fail closed: an unreadable store must not turn a user's opt-out into a write.
    return true
  }
}

const releaseTasksBeforeIsolation: (() => Promise<unknown>)[] = []

// Why: once isolated, Orca can no longer restore a user's own CLI login that a managed account
// replaced, so owners of such state hand it back while writes are still allowed.
export function onBeforeAgentConfigIsolation(task: () => Promise<unknown>): void {
  releaseTasksBeforeIsolation.push(task)
}

export async function releaseExternalAgentStateBeforeIsolation(): Promise<void> {
  for (const task of releaseTasksBeforeIsolation) {
    try {
      await task()
    } catch (error) {
      console.warn('[agent-config-isolation] failed to release state before isolating:', error)
    }
  }
}

export function isIsolationTurningOn(
  current: IsolationSettings,
  update: IsolationSettings
): boolean {
  return isAgentConfigIsolatedInSettings(update) && !isAgentConfigIsolatedInSettings(current)
}

// Why before persisting: the release restores the user's own CLI login, a write isolation forbids.
export async function releaseIfIsolationTurningOn(
  current: IsolationSettings,
  update: IsolationSettings
): Promise<void> {
  if (isIsolationTurningOn(current, update)) {
    await releaseExternalAgentStateBeforeIsolation()
  }
}

// Why only on release: turning isolation on must not write, not even a hook removal.
export function didIsolationTurnOff(before: IsolationSettings, after: IsolationSettings): boolean {
  return isAgentConfigIsolatedInSettings(before) && !isAgentConfigIsolatedInSettings(after)
}

export function resetAgentConfigIsolationForTests(): void {
  readIsolationSettings = null
  releaseTasksBeforeIsolation.length = 0
}
