/** Reclaim this desktop's exited-holder lock early only with unchanged token/instance and three quiet heartbeats (BUG-23). sshd can outlive the desktop: fence takeover also requires an absent mutation lock, holds it during the steal, and makes admitted mutations recheck ownership. */
import {
  ORCAD_FENCE_OWNER_FILENAME,
  posixOrcadFenceOwnedTest
} from '../managed-server/activation/orcad-activation-fence-scope'
import {
  forgetHeldOrcadFence,
  orcadFenceTokensHeldByExitedProcesses
} from './orcad-held-fence-tokens'
import { readBoundedOrcadRemoteRecord } from '../managed-server/install/orcad-remote-record-file'
import {
  execOrcadRemote,
  type OrcadRemoteExecTarget
} from '../managed-server/install/orcad-remote-runtime-control'
import {
  installOrcadWindowsHostScript,
  orcadWindowsHostOpCommand
} from '../managed-server/install/orcad-remote-windows-node'
import {
  ORCAD_EXITED_OWN_LOCK_QUIET_SECONDS,
  ORCAD_STATE_MUTATION_LOCK_DIRNAME
} from '../managed-server/host-state/orcad-state-snapshot-members'
import { CMD_EXE_COMMAND_LINE_MAX_CHARS } from '../providers/windows-shell-args'
import { quotePosixShell } from '../../shared/shell-argument-quoting'
import type { InstallLockExitedOwnerProof } from '../managed-server/install/remote-install-lock'
import { isWindowsRemoteHost, joinRemotePath } from './ssh-remote-platform'

// Bound Windows command length; omitted older tokens simply wait for normal stale-lock arbitration.
const MAX_WINDOWS_CANDIDATES = 16

type ExitedOwnLockScope = { baseDir: string; guardsStateMutation: boolean }

export function exitedOwnLockProof(
  target: OrcadRemoteExecTarget,
  scope: ExitedOwnLockScope
): InstallLockExitedOwnerProof {
  return {
    find: (lockDir) => findExitedOwnLockToken(target, lockDir, scope),
    reclaimed: forgetHeldOrcadFence,
    quietSeconds: ORCAD_EXITED_OWN_LOCK_QUIET_SECONDS,
    mutationLock: mutationLockOf(target, scope) ?? undefined
  }
}

/** Return an exited local holder's token only while the lock still names it; null leaves normal stale-lock arbitration. */
export async function findExitedOwnLockToken(
  target: OrcadRemoteExecTarget,
  lockDir: string,
  scope: ExitedOwnLockScope
): Promise<string | null> {
  const exited = orcadFenceTokensHeldByExitedProcesses()
  if (exited.length === 0) {
    return null
  }
  try {
    const token = isWindowsRemoteHost(target.host)
      ? await findOnWindows(target, lockDir, scope, exited.slice(-MAX_WINDOWS_CANDIDATES))
      : await findOnPosix(target, lockDir, scope, exited)
    return token !== null && exited.includes(token) ? token : null
  } catch {
    // Unanswered: the stale window still applies.
    return null
  }
}

function mutationLockOf(target: OrcadRemoteExecTarget, scope: ExitedOwnLockScope): string | null {
  return scope.guardsStateMutation
    ? joinRemotePath(target.host, scope.baseDir, ORCAD_STATE_MUTATION_LOCK_DIRNAME)
    : null
}

async function findOnPosix(
  target: OrcadRemoteExecTarget,
  lockDir: string,
  scope: ExitedOwnLockScope,
  exited: string[]
): Promise<string | null> {
  const owner = await readBoundedOrcadRemoteRecord(
    target,
    joinRemotePath(target.host, lockDir, ORCAD_FENCE_OWNER_FILENAME),
    64
  )
  const token = owner.state === 'present' ? owner.raw.trim() : ''
  if (!exited.includes(token)) {
    return null
  }
  const command = exitedOwnLockCheckCommand({ lockDir, token }, mutationLockOf(target, scope))
  return (await execOrcadRemote(target, command)).trim() === 'EXITED_OWNER' ? token : null
}

/** Read ownership in the host script so one node.exe invocation returns the proven token. */
async function findOnWindows(
  target: OrcadRemoteExecTarget,
  lockDir: string,
  scope: ExitedOwnLockScope,
  exited: string[]
): Promise<string | null> {
  const command = orcadWindowsHostOpCommand(target.host, scope.baseDir, 'fence-exited-owner', [
    lockDir,
    scope.guardsStateMutation ? '1' : '0',
    ...exited
  ])
  // Overlong sshd/cmd.exe commands cannot prove ownership; retain the normal stale window.
  if (command.length > CMD_EXE_COMMAND_LINE_MAX_CHARS) {
    return null
  }
  await installOrcadWindowsHostScript(target, scope.baseDir)
  const output = await execOrcadRemote(target, command)
  const match = /^EXITED_OWNER (\S+)$/u.exec(output.trim().split(/\r?\n/u).at(-1) ?? '')
  return match ? match[1] : null
}

function exitedOwnLockCheckCommand(
  lock: { lockDir: string; token: string },
  mutationLock: string | null
): string {
  const quiet = (path: string): string =>
    `[ -n "$(find ${path} -maxdepth 0 -mmin +${ORCAD_EXITED_OWN_LOCK_QUIET_SECONDS / 60} 2>/dev/null)" ]`
  return [
    `${posixOrcadFenceOwnedTest(lock)} && ${quiet(quotePosixShell(lock.lockDir))} || exit 0;`,
    ...(mutationLock
      ? [
          // Refuse any mutation lock, matching the steal's absent-lock requirement.
          `[ -e ${quotePosixShell(mutationLock)} ] && exit 0;`
        ]
      : []),
    'echo EXITED_OWNER'
  ].join(' ')
}
