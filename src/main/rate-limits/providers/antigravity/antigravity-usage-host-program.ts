// Which agy the host usage probe runs: the user's own, else Orca's copy where agy holds a login.

import { homedir } from 'node:os'
import { agyCredentialPresence } from '../../../antigravity/agy-credential-presence'
import { resolveCommandOnLocalPath } from '../../../ipc/command-path/command-path-resolver'
import {
  isManagedAgentCopyPath,
  launchReleasesPending,
  managedAgentCommandFor
} from '../../../managed-agent-cli/managed-agent-cli-registry'
import { readInstalledManagedAgents } from '../../../preflight/managed-agent-detection'
import { withTimeout } from '../../../../shared/concurrency/promise-timeout-fallback'
import type { UsageRateLimitFailureKind } from '../../../../shared/agent-usage/rate-limits/rate-limit-types'

export type AntigravityHostProgramOptions = {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  resolveCommand?: typeof resolveCommandOnLocalPath
  credentialPresence?: typeof agyCredentialPresence
}

/** Reporting agy as missing where Orca's copy is installed but agy holds no readable login would
 *  hide the sign-in step. */
export type AntigravityHostProgram =
  | { kind: 'found'; program: string }
  | { kind: 'missing' }
  | { kind: 'login-unreadable'; message: string; failureKind: UsageRateLimitFailureKind }

const MANAGED_LOGIN_UNREADABLE = {
  absent: {
    message: 'Antigravity usage is not available. Sign in to Antigravity, then refresh usage.',
    failureKind: 'missing-credentials'
  },
  locked: {
    message:
      'Antigravity usage is not available. The Antigravity sign-in could not be read without unlocking the system keyring. Unlock it or sign in to Antigravity, then refresh usage.',
    failureKind: 'keychain-unavailable'
  }
} as const satisfies Record<
  'absent' | 'locked',
  { message: string; failureKind: UsageRateLimitFailureKind }
>

// Launch reclaim waits out the first-window fence (12 s at most) after the window opens.
const LAUNCH_RELEASES_WAIT_MS = 15_000
let launchReleasesWait: Promise<void> | null = null

/** Orca's installed agy where it may run. A read before launch reclaim records it waits for that
 *  read when the disk check agent detection uses finds a copy, so the first read never reports agy
 *  as missing. */
async function installedManagedAgy(command: string): Promise<string | null> {
  if (!(await readInstalledManagedAgents()).includes('antigravity')) {
    return null
  }
  const pending = launchReleasesPending()
  if (pending) {
    // Shared, so a reclaim that never comes delays one read, not every poll.
    launchReleasesWait ??= withTimeout(pending, LAUNCH_RELEASES_WAIT_MS, undefined)
    await launchReleasesWait
  }
  return managedAgentCommandFor('antigravity', command, { use: false })
}

export async function resolveAntigravityHostProgram(
  command: string,
  options: AntigravityHostProgramOptions
): Promise<AntigravityHostProgram> {
  const { platform, env } = options
  const found = await (options.resolveCommand ?? resolveCommandOnLocalPath)(command, {
    platform,
    env
  })
  // A PATH an Orca terminal passed on can hold Orca's copy, which is never the user's own agy.
  if (found && !isManagedAgentCopyPath('antigravity', found)) {
    return { kind: 'found', program: found }
  }
  const managed = await installedManagedAgy(command)
  if (!managed) {
    return { kind: 'missing' }
  }
  // With no login to find, asking agy would open its browser sign-in or a keyring unlock prompt.
  const presence = await (options.credentialPresence ?? agyCredentialPresence)(
    env.HOME ?? env.USERPROFILE ?? homedir()
  )
  return presence === 'present'
    ? { kind: 'found', program: managed }
    : { kind: 'login-unreadable', ...MANAGED_LOGIN_UNREADABLE[presence] }
}
