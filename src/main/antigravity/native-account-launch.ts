import { withAntigravityAccountOperation } from './native-account-operation'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import { tokenizeStartupCommand } from '../../shared/tui-agent-startup-shell'
import { recognizeAgentProcessFromCommandLine } from '../../shared/agent-process-recognition'
import { isAntigravityFileStorageHost } from './native-credential-backend'
import { createEncryptedAntigravityAccountStore } from './native-account-store'
import {
  prepareAntigravityAccountTargetForLaunch,
  getAntigravityWslAccountVaultRoot,
  getAntigravityAccountVaultPath
} from './native-account-host'

export async function prepareAntigravityAccountForLaunch(args: {
  launchAgent?: string
  command?: string
  connectionId?: string | null
  isWsl?: boolean
  wslDistro?: string | null
  env?: NodeJS.ProcessEnv
  envIsComplete?: boolean
  envToDelete?: readonly string[]
}): Promise<{ wslDistro: string; authorityId: string } | void> {
  const agent =
    args.launchAgent ??
    (args.command ? recognizeAgentProcessFromCommandLine(args.command)?.agent : null)
  // The SSH execution owner prepares its own account.
  if (agent !== 'antigravity' || args.connectionId) {
    return
  }
  if (args.isWsl) {
    if (!existsSync(getAntigravityWslAccountVaultRoot())) {
      return
    }
    if (process.platform !== 'win32') {
      throw new Error('WSL account preparation requires Windows')
    }
    const authority = await withAntigravityAccountOperation((operation) =>
      prepareAntigravityAccountTargetForLaunch(
        { runtime: 'wsl', wslDistro: args.wslDistro ?? null },
        operation,
        () => assertWslLaunchAuthority(args)
      )
    )
    if (authority) {
      return { wslDistro: authority.distro, authorityId: authority.authorityId }
    }
    return
  }
  const path = getAntigravityAccountVaultPath()
  if (!existsSync(path)) {
    return
  }
  if (
    !(await Promise.resolve(createEncryptedAntigravityAccountStore(path).read())).selectedAccountId
  ) {
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
  await withAntigravityAccountOperation((operation) =>
    prepareAntigravityAccountTargetForLaunch({ runtime: 'host' }, operation)
  )
}

function assertWslLaunchAuthority(args: {
  command?: string
  env?: NodeJS.ProcessEnv
  envIsComplete?: boolean
  envToDelete?: readonly string[]
}): void {
  const env = args.envIsComplete ? { ...args.env } : { ...process.env, ...args.env }
  for (const key of args.envToDelete ?? []) {
    delete env[key]
  }
  const authorityKeys = new Set([
    'HOME',
    'USER',
    'LOGNAME',
    'SHELL',
    'WSL_DISTRO_NAME',
    'WSL_INTEROP',
    'WSL_USER'
  ])
  const transportedAuthority = (env.WSLENV ?? '')
    .split(':')
    .some((entry) => authorityKeys.has(entry.split('/')[0]))
  const command = args.command ? tokenizeStartupCommand(args.command, 'posix') : null
  const unverifiedCommand =
    command &&
    (!command.ok ||
      command.spans.some((span) => span.divergesFromShell) ||
      recognizeAgentProcessFromCommandLine(command.tokens[0] ?? '')?.agent !== 'antigravity')
  if (transportedAuthority || unverifiedCommand) {
    throw new Error(
      'This agy launch uses an unverifiable credential authority; remove user, HOME or command wrappers.'
    )
  }
}
