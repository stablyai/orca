import { bunOwnedRuntimeArgs } from '../../shared/bun-owned-runtime-args'
import { posix } from 'node:path'
import { resolveShellKind } from '../terminal-history'
import { hashWorktreeId } from '../terminal-history-id'
import { dropInheritedOrcaFishHistory, relayFishHistorySessionName } from '../fish-history-session'
import { dropInheritedOrcaHistFile } from '../worktree-history-file-path'
import type { PtySpawnOptions } from '../providers/types'
import type { WslAccountExecutionContext } from './wsl-account-execution-context'
import type { createRunningWslRuntimeRunner } from './wsl-bun-runtime'
import { WSL_GUEST_HISTORY_PREPARE_SCRIPT } from './wsl-guest-terminal-history-script'

/** Plans on the desktop; the captured guest alone creates its history files. */
export async function prepareWslGuestTerminalHistory(
  execution: Pick<ReturnType<typeof createRunningWslRuntimeRunner>, 'run'>,
  owner: WslAccountExecutionContext,
  runtime: string,
  envBinary: string,
  options: PtySpawnOptions,
  env: Record<string, string>,
  shell: string
): Promise<void> {
  if (!options.worktreeId || options.historyIsolationEnabled !== true) {
    return
  }
  delete env.ORCA_HISTFILE
  dropInheritedOrcaFishHistory(env)
  dropInheritedOrcaHistFile(env)
  const kind = resolveShellKind(shell)
  if (kind !== 'bash' && kind !== 'zsh' && kind !== 'fish') {
    return
  }
  if (kind === 'fish' ? env.fish_history : env.HISTFILE) {
    return
  }
  const profile = options.env?.ORCA_USER_DATA_PATH
  if (!profile) {
    throw new Error('Guest history isolation requires the captured Orca profile')
  }
  const worktreeHash = hashWorktreeId(options.worktreeId)
  const directory = posix.join(
    owner.home,
    '.orca-wsl',
    hashWorktreeId(profile),
    'terminal-history',
    worktreeHash
  )
  // Guest desktops must not sweep history owned by an independently updating Windows client.
  const fishSession =
    kind === 'fish'
      ? relayFishHistorySessionName(hashWorktreeId(JSON.stringify([profile, options.worktreeId])))
      : undefined
  const fishHistoryDir = fishSession
    ? posix.join(
        env.XDG_DATA_HOME?.startsWith('/')
          ? env.XDG_DATA_HOME
          : posix.join(owner.home, '.local/share'),
        'fish'
      )
    : undefined
  const payload = { owner, directory, worktreeId: options.worktreeId, fishSession, fishHistoryDir }
  const result = await execution.run({
    program: envBinary,
    args: [
      ...[
        'NODE_OPTIONS',
        'NODE_PATH',
        'BUN_OPTIONS',
        'BUN_INSPECT',
        'ELECTRON_RUN_AS_NODE'
      ].flatMap((key) => ['-u', key]),
      runtime,
      ...bunOwnedRuntimeArgs('linux'),
      '-e',
      WSL_GUEST_HISTORY_PREPARE_SCRIPT,
      JSON.stringify(payload)
    ],
    loginPath: 'none'
  })
  if (result !== 'ready') {
    throw new Error('Guest terminal history preparation failed')
  }
  if (fishSession) {
    env.fish_history = fishSession
  } else {
    env.HISTFILE = posix.join(directory, `${kind}_history`)
    env.ORCA_HISTFILE = env.HISTFILE
  }
}
