// Launches on a chosen Claude account (the session mover's resume), whatever the selection is.
// The router owns the folders and setup; these functions only decide what a chosen launch gets.
import type { GlobalSettings } from '../../shared/global-settings-types'
import {
  claudeAccountUnknown,
  claudeAccountWslUnsupported,
  claudeProfileMissing
} from './claude-profile-launch-errors'
import { isDirectory } from './claude-profile-homes'
import { readUserClaudeConfigDirAsSet } from './claude-profile-paths'
import type { ClaudeEnvPatch } from './environment'
import type { ClaudeRuntimeAuthPreparation } from './runtime-auth/runtime-auth-types'
import { findClaudeAccount } from './runtime-selection'

/** What the router lends a chosen-account launch. */
export type ChosenAccountRouting = {
  getSettings: () => Pick<GlobalSettings, 'claudeManagedAccounts'>
  coveredBySystemDefault: (accountId: string) => boolean
  /** Whether the account's own folder holds a login. */
  hasOwnLogin: (accountId: string) => boolean
  accountHome: (accountId: string) => string
  systemDefaultHome: () => string
  /** The login shell's env once resolved. */
  env: () => NodeJS.ProcessEnv
  envReady: () => Promise<unknown>
  setUpForLaunch: (accountId: string) => Promise<void>
}

/**
 * Why refuse an unknown id: the mover names ids from its registry, so one no saved account explains
 * is a bug, never a folder to create. Why refuse WSL: host setup would hand back an empty host folder.
 */
function assertKnownHostAccount(routing: ChosenAccountRouting, accountId: string): void {
  const account = findClaudeAccount(routing.getSettings(), accountId)
  if (!account) {
    throw claudeAccountUnknown()
  }
  if (account.managedAuthRuntime === 'wsl') {
    throw claudeAccountWslUnsupported()
  }
}

function envForKnown(
  routing: ChosenAccountRouting,
  accountId: string,
  covered: boolean
): ClaudeEnvPatch {
  if (covered) {
    // Why the user's own value, unresolved: Claude keys its login by the literal string (as terminalEnv).
    const own = readUserClaudeConfigDirAsSet(routing.env())
    return own ? { CLAUDE_CONFIG_DIR: own } : {}
  }
  const home = routing.accountHome(accountId)
  if (!isDirectory(home)) {
    throw claudeProfileMissing()
  }
  return { CLAUDE_CONFIG_DIR: home }
}

/**
 * A bare CLAUDE_CONFIG_DIR. Why never the pointer or the injected marker: the pane's `claude`
 * function re-reads the selected-host pointer whenever CLAUDE_CONFIG_DIR equals
 * ORCA_CLAUDE_INJECTED_CONFIG_DIR, so a launch carrying both ran on the selected account.
 *
 * Contract: the patch only sets keys (applyClaudeEnvPatch never clears), and a covered account's
 * patch is `{}` or the user's own CLAUDE_CONFIG_DIR. So the base env must carry none of Orca's
 * routing keys: CLAUDE_CONFIG_DIR, ORCA_CLAUDE_PROFILE_POINTER, ORCA_CLAUDE_INJECTED_CONFIG_DIR,
 * ORCA_CLAUDE_USER_CONFIG_DIR. A caller starting from a pane/terminal env deletes them first, or a
 * covered account can run on the selected one.
 */
export function chosenAccountLaunchEnv(
  routing: ChosenAccountRouting,
  accountId: string
): ClaudeEnvPatch {
  assertKnownHostAccount(routing, accountId)
  return envForKnown(routing, accountId, routing.coveredBySystemDefault(accountId))
}

export function chosenAccountPreparation(
  routing: ChosenAccountRouting,
  accountId: string
): ClaudeRuntimeAuthPreparation {
  assertKnownHostAccount(routing, accountId)
  return preparationForKnown(routing, accountId, routing.coveredBySystemDefault(accountId))
}

/** Why `covered` is passed in: a sign-in between two reads could set up one folder and name another. */
function preparationForKnown(
  routing: ChosenAccountRouting,
  accountId: string,
  covered: boolean
): ClaudeRuntimeAuthPreparation {
  return {
    configDir: covered ? routing.systemDefaultHome() : routing.accountHome(accountId),
    runtime: 'host',
    wslDistro: null,
    wslLinuxConfigDir: null,
    envPatch: envForKnown(routing, accountId, covered),
    provenance: covered ? 'system' : `profile:${accountId}`
  }
}

/** Its folder is set up or refreshed first. */
export async function prepareChosenAccountLaunch(
  routing: ChosenAccountRouting,
  accountId: string
): Promise<ClaudeRuntimeAuthPreparation> {
  assertKnownHostAccount(routing, accountId)
  // Why wait only without the account's own login (as prepareLaunch): coverage then depends on the
  // login shell's CLAUDE_CONFIG_DIR; with one it is false whatever that is, and setup awaits it itself.
  if (!routing.hasOwnLogin(accountId)) {
    await routing.envReady()
  }
  const covered = routing.coveredBySystemDefault(accountId)
  if (!covered) {
    await routing.setUpForLaunch(accountId)
  }
  return preparationForKnown(routing, accountId, covered)
}
