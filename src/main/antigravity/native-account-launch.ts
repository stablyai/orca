import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import { recognizeAgentProcessFromCommandLine } from '../../shared/agent-process-recognition'
import { isAntigravityFileStorageHost } from './native-credential-backend'
import { createEncryptedAntigravityAccountStore } from './native-account-store'
import { getAntigravityAccountService, getAntigravityAccountVaultPath } from './native-account-host'

export async function prepareAntigravityAccountForLaunch(args: {
  launchAgent?: string
  command?: string
  connectionId?: string | null
  isWsl?: boolean
  env?: NodeJS.ProcessEnv
  envIsComplete?: boolean
  envToDelete?: readonly string[]
}): Promise<void> {
  const agent =
    args.launchAgent ??
    (args.command ? recognizeAgentProcessFromCommandLine(args.command)?.agent : null)
  // Client snapshots never select accounts for a relay or a client-selected distro.
  if (agent !== 'antigravity' || args.connectionId || args.isWsl) {
    return
  }
  const path = getAntigravityAccountVaultPath()
  if (!existsSync(path)) {
    return
  }
  if (!(await createEncryptedAntigravityAccountStore(path).read()).selectedAccountId) {
    return
  }
  const env = args.envIsComplete ? { ...args.env } : { ...process.env, ...args.env }
  for (const key of args.envToDelete ?? []) {
    delete env[key]
  }
  const home = env.HOME ?? env.USERPROFILE
  if (
    args.envToDelete?.some((key) => ['HOME', 'USERPROFILE'].includes(key)) ||
    (home && resolve(home) !== resolve(getAppEnvironment().getPath('home'))) ||
    isAntigravityFileStorageHost(env) !== isAntigravityFileStorageHost(process.env)
  ) {
    throw new Error(
      'This agy launch uses a different credential authority from the selected Antigravity account.'
    )
  }
  await getAntigravityAccountService({ runtime: 'host' }).prepareForLaunch()
}
