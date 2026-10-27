import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import { recognizeAgentProcessFromCommandLine } from '../../shared/agent-process-recognition'
import { isAntigravityFileStorageHost } from './native-credential-backend'
import { createEncryptedAntigravityAccountStore } from './native-account-store'
import { getAntigravityAccountService, getAntigravityAccountVaultPath } from './native-account-host'

type AntigravityLaunchAccountArgs = {
  launchAgent?: string
  command?: string
  connectionId?: string | null
  isWsl?: boolean
  env?: NodeJS.ProcessEnv
  envIsComplete?: boolean
  envToDelete?: readonly string[]
  resumeOnSelectedAccount?: boolean
}

/** A selected account exists for this local agy launch, or null when launch prep does not apply. */
function selectedAntigravityLaunch(
  args: AntigravityLaunchAccountArgs
): { conflict: string | null } | null {
  const agent =
    args.launchAgent ??
    (args.command ? recognizeAgentProcessFromCommandLine(args.command)?.agent : null)
  // Client snapshots never select accounts for a relay or a client-selected distro.
  if (agent !== 'antigravity' || args.connectionId || args.isWsl) {
    return null
  }
  const path = getAntigravityAccountVaultPath()
  if (!existsSync(path)) {
    return null
  }
  if (!createEncryptedAntigravityAccountStore(path).read().selectedAccountId) {
    return null
  }
  const env = args.envIsComplete ? { ...args.env } : { ...process.env, ...args.env }
  for (const key of args.envToDelete ?? []) {
    delete env[key]
  }
  const home = env.HOME ?? env.USERPROFILE
  const conflict =
    args.envToDelete?.some((key) => key === 'HOME' || key === 'USERPROFILE') ||
    (home && resolve(home) !== resolve(getAppEnvironment().getPath('home'))) ||
    isAntigravityFileStorageHost(env) !== isAntigravityFileStorageHost(process.env)
      ? 'This agy launch uses a different credential authority from the selected Antigravity account.'
      : null
  return { conflict }
}

/** Strict session restart refuses a different Antigravity credential authority before stop. */
export function antigravitySessionRestartRefusal(
  args: AntigravityLaunchAccountArgs
): string | null {
  if (args.resumeOnSelectedAccount !== false) {
    return null
  }
  return selectedAntigravityLaunch(args)?.conflict ?? null
}

export async function prepareAntigravityAccountForLaunch(
  args: AntigravityLaunchAccountArgs
): Promise<void> {
  const selected = selectedAntigravityLaunch(args)
  if (!selected) {
    return
  }
  if (selected.conflict) {
    throw new Error(selected.conflict)
  }
  // Session restart keeps the on-disk credential instead of preparing the selected account.
  if (args.resumeOnSelectedAccount === false) {
    return
  }
  await getAntigravityAccountService({ runtime: 'host' }).prepareForLaunch()
}
