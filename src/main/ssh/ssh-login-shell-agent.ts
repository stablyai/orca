import { statSync } from 'node:fs'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { resolveLoginShellEnvironment } from '../startup/login-shell-environment'

type LoginShellEnvironmentResolver = () => Promise<NodeJS.ProcessEnv>

type LoginShellAgentSettingsSource = {
  getSettings(): Pick<GlobalSettings, 'sshUseLoginShellAgent'>
  onSettingsChanged(
    listener: (
      updates: Partial<GlobalSettings>,
      settings: Pick<GlobalSettings, 'sshUseLoginShellAgent'>
    ) => void
  ): () => void
}

// undefined = not yet captured; the launch value may itself be absent.
let launchAgentSocket: { value: string | undefined } | undefined
let pending: Promise<void> = Promise.resolve()
let generation = 0
let settingsCleanup: (() => void) | null = null

/** Idempotent, so a repeated startup path cannot stack listeners. */
export function bindLoginShellAgentSetting(store: LoginShellAgentSettingsSource): void {
  settingsCleanup?.()
  void applyLoginShellAgentSetting(store.getSettings().sshUseLoginShellAgent === true)
  settingsCleanup = store.onSettingsChanged((updates, settings) => {
    if ('sshUseLoginShellAgent' in updates) {
      void applyLoginShellAgentSetting(settings.sshUseLoginShellAgent === true)
    }
  })
}

function isLiveSocket(path: string): boolean {
  try {
    return statSync(path).isSocket()
  } catch {
    return false
  }
}

function restoreLaunchAgentSocket(): void {
  const value = launchAgentSocket?.value
  if (value === undefined) {
    delete process.env.SSH_AUTH_SOCK
  } else {
    process.env.SSH_AUTH_SOCK = value
  }
}

/**
 * Opt-in: use the SSH_AUTH_SOCK the user's login shell exports (1Password, Secretive, gpg-agent
 * set in .zshrc) instead of the one Orca was launched with.
 *
 * Why process.env rather than a parameter: ssh2 agent resolution, spawned system `ssh` and
 * `ssh -G` all read it, so one write keeps both transports on the same agent — the same approach
 * PATH hydration takes. Only a live socket is adopted; otherwise the launch value stays.
 */
export function applyLoginShellAgentSetting(
  enabled: boolean,
  resolveEnvironment: LoginShellEnvironmentResolver = () => resolveLoginShellEnvironment()
): Promise<void> {
  launchAgentSocket ??= { value: process.env.SSH_AUTH_SOCK }
  const current = ++generation
  // Why not Windows: the OpenSSH agent there is a fixed named pipe, not a per-shell socket.
  if (!enabled || process.platform === 'win32') {
    restoreLaunchAgentSocket()
    pending = Promise.resolve()
    return pending
  }
  pending = resolveEnvironment()
    .then((env) => {
      if (current !== generation) {
        return
      }
      const socket = env.SSH_AUTH_SOCK
      if (socket && isLiveSocket(socket)) {
        process.env.SSH_AUTH_SOCK = socket
        return
      }
      restoreLaunchAgentSocket()
      console.warn('[ssh] Login shell exports no usable SSH_AUTH_SOCK; keeping the launch agent')
    })
    .catch(() => {
      if (current === generation) {
        restoreLaunchAgentSocket()
      }
    })
  return pending
}

/** Lets a connect attempt start only after an enabled setting has been applied. */
export function waitForLoginShellAgent(): Promise<void> {
  return pending
}

export function resetLoginShellAgentForTests(): void {
  settingsCleanup?.()
  settingsCleanup = null
  if (launchAgentSocket) {
    restoreLaunchAgentSocket()
  }
  launchAgentSocket = undefined
  pending = Promise.resolve()
  generation = 0
}
