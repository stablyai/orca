import { credentialFileExists } from '../credentials/credential-file-io'
import { resolve } from 'node:path'
import { getAppEnvironment } from '../../shared/app-lifecycle/app-environment'
import { recognizeAgentProcessFromCommandLine } from '../../shared/agent-status/process/agent-process-recognition'
import { isAntigravityFileStorageHostAsync } from './native-file-credentials'
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
  // Windows account selection applies the host default; the shell and agent own each launch.
  if (process.platform === 'win32') {
    return
  }
  const agent =
    args.launchAgent ??
    (args.command ? recognizeAgentProcessFromCommandLine(args.command)?.agent : null)
  // Client snapshots never select accounts for a relay or a client-selected distro.
  if (agent !== 'antigravity' || args.connectionId || args.isWsl) {
    return
  }
  const path = getAntigravityAccountVaultPath()
  if (!(await credentialFileExists(path))) {
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
    (await isAntigravityFileStorageHostAsync(env)) !==
      (await isAntigravityFileStorageHostAsync(process.env))
  ) {
    throw new Error(
      'This agy launch uses a different credential authority from the selected Antigravity account.'
    )
  }
  await (await getAntigravityAccountService({ runtime: 'host' })).prepareForLaunch()
}

/** Chats never had the launch gate: put the selected account back when that's safe, else start on
 *  agy's current login as before. */
export async function restoreAntigravityAccountForChat(
  env: Readonly<Record<string, string>>
): Promise<void> {
  try {
    await prepareAntigravityAccountForLaunch({ launchAgent: 'antigravity', env: { ...env } })
  } catch (error) {
    console.warn("[antigravity] chat starts on agy's current login:", error)
  }
}
