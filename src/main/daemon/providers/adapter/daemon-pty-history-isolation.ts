import type { PtySpawnOptions } from '../../../providers/pty-provider-contract'
import { resolveWslSessionContext } from '../../pty-subprocess/wsl-session-context'
import { resolveSafePtyDefaultCwd } from '../../../providers/pty-default-cwd'
import { resolveUnixShellPath } from '../../../providers/local-pty/local-pty-executable-spawn'
import {
  injectHistoryEnv,
  injectWslFishHistoryEnv,
  logHistoryInjection
} from '../../../pty/history/terminal-history'
import { addWslEnvKeys } from '../../../../shared/wsl-env'

export function withDaemonHistoryIsolation(opts: PtySpawnOptions): PtySpawnOptions {
  const wslContext = resolveWslSessionContext({
    cwd: opts.cwd,
    sessionId: opts.sessionId,
    shellOverride: opts.shellOverride,
    terminalWindowsWslDistro: opts.terminalWindowsWslDistro
  })
  if (
    opts.attachOnly === true ||
    (opts.sessionId !== undefined && opts.isNewSession !== true) ||
    !opts.worktreeId ||
    opts.historyIsolationEnabled !== true ||
    (process.platform === 'win32' && !wslContext)
  ) {
    return opts
  }
  const env = { ...opts.env }
  const preferredShell = wslContext
    ? 'bash'
    : opts.shellOverride || env.SHELL || process.env.SHELL || '/bin/zsh'
  const shellPath = resolveUnixShellPath(preferredShell)
  const historyArgs = [
    env,
    opts.worktreeId,
    shellPath,
    opts.cwd ?? resolveSafePtyDefaultCwd()
  ] as const
  const result = wslContext
    ? injectHistoryEnv(...historyArgs, { wslDistro: wslContext.distro })
    : injectHistoryEnv(...historyArgs)
  if (wslContext) {
    injectWslFishHistoryEnv(env, opts.worktreeId, wslContext.distro)
    addWslEnvKeys(env, ['HISTFILE', 'fish_history'])
  }
  logHistoryInjection(opts.worktreeId, result)
  return { ...opts, env }
}
