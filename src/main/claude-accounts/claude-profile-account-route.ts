import { existsSync } from 'node:fs'
import {
  CLAUDE_INJECTED_CONFIG_DIR_ENV,
  CLAUDE_PROFILE_POINTER_ENV,
  CLAUDE_USER_CONFIG_DIR_ENV
} from '../../shared/claude-profile-routing'
import { keptAccountRefusals } from '../agent-accounts/kept-account-refusals'
import { claudeProfileMissing, claudeProfileSetupFailed } from './claude-profile-launch-errors'
import { claudeProfileMarkerPath, describeClaudeProfile } from './claude-profile-paths'
import { getClaudeProfileRouter, isDirectory } from './claude-profile-installed-router'
import type { ClaudeProfileRouter } from './claude-profile-router'
import type { ClaudeEnvPatch } from './environment'
import type { ClaudeRuntimeAuthPreparation } from './runtime-auth/runtime-auth-types'

const REFRESH_WAIT_MS = 5_000

type AccountRouter = Pick<
  ClaudeProfileRouter,
  | 'accountPointers'
  | 'envReady'
  | 'accountLogin'
  | 'prepareAccount'
  | 'removeAccount'
  | 'systemDefaultHome'
  | 'userConfigDir'
>

/** A kept pane's spawn env, naming its account's own pointer; never throws, never names the selection's. */
export function claudeTerminalEnvForAccount(
  router: AccountRouter,
  accountId: string | null
): ClaudeEnvPatch {
  const pointers = router.accountPointers
  let pointer: string
  try {
    pointer = pointers.pointerPath(accountId)
  } catch {
    // Why: an id that names no file still must not fall back to the selection.
    return { [CLAUDE_PROFILE_POINTER_ENV]: pointers.pointerPath(null) }
  }
  if (accountId !== null && pointers.isRetired(accountId)) {
    return { [CLAUDE_PROFILE_POINTER_ENV]: pointer }
  }
  try {
    pointers.update(accountId)
    const home = accountId === null ? '' : pointers.routeFor(accountId)
    if (!home || !isDirectory(home)) {
      return { [CLAUDE_PROFILE_POINTER_ENV]: pointer }
    }
    const env = {
      [CLAUDE_PROFILE_POINTER_ENV]: pointer,
      CLAUDE_CONFIG_DIR: home,
      [CLAUDE_INJECTED_CONFIG_DIR_ENV]: home
    }
    const userConfigDir = router.userConfigDir()
    return userConfigDir ? { ...env, [CLAUDE_USER_CONFIG_DIR_ENV]: userConfigDir } : env
  } catch {
    return { [CLAUDE_PROFILE_POINTER_ENV]: pointer }
  }
}

/** A pane started kept on an account: its env names that account's own pointer, never the selection's. */
export function withClaudeKeptAccountTerminalEnv<Env extends Record<string, string> | undefined>(
  env: Env,
  accountId: string | null
): Env | Record<string, string> {
  const router = getClaudeProfileRouter()
  return router ? { ...env, ...claudeTerminalEnvForAccount(router, accountId) } : env
}

/** The selection's launch preparation for a given account, with that account's pointer written first. */
export async function prepareClaudeLaunchForAccount(
  router: AccountRouter,
  accountId: string | null,
  options: { refreshWaitMs?: number } = {}
): Promise<ClaudeRuntimeAuthPreparation> {
  const pointers = router.accountPointers
  // Why retired too: setup would recreate the folder its removal is deleting.
  if (
    accountId !== null &&
    (pointers.isRetired(accountId) || pointers.routeFor(accountId) === null)
  ) {
    throw keptAccountRefusals.accountRemoved()
  }
  // Why: whether System default covers an account depends on the login shell's env.
  if (accountId === null || !router.accountLogin(accountId)) {
    await router.envReady
  }
  pointers.update(accountId)
  const pointer = pointers.pointerPath(accountId)
  const home = accountId === null ? '' : pointers.routeFor(accountId)
  if (!home || accountId === null) {
    return {
      configDir: router.systemDefaultHome(),
      runtime: 'host',
      wslDistro: null,
      wslLinuxConfigDir: null,
      envPatch: { [CLAUDE_PROFILE_POINTER_ENV]: pointer },
      provenance: 'system'
    }
  }
  const profile = describeClaudeProfile(pointers.dataRoot, accountId, {
    executionHostId: 'local',
    runtime: 'host'
  })
  if (!existsSync(claudeProfileMarkerPath(profile))) {
    const prepared = await router.prepareAccount(accountId).then(
      () => true,
      () => false
    )
    if (!prepared) {
      throw claudeProfileSetupFailed()
    }
  } else {
    // Why capped and never thrown: a set-up folder runs on its last refresh rather than not at all.
    const refresh = router.prepareAccount(accountId).catch((error: unknown) => {
      console.warn('[claude-profile] Account refresh failed:', error)
    })
    const waitMs = options.refreshWaitMs ?? REFRESH_WAIT_MS
    await Promise.race([refresh, new Promise((resolve) => setTimeout(resolve, waitMs).unref())])
  }
  if (!isDirectory(home)) {
    throw claudeProfileMissing()
  }
  return {
    configDir: home,
    runtime: 'host',
    wslDistro: null,
    wslLinuxConfigDir: null,
    envPatch: {
      [CLAUDE_PROFILE_POINTER_ENV]: pointer,
      CLAUDE_CONFIG_DIR: home,
      [CLAUDE_INJECTED_CONFIG_DIR_ENV]: home
    },
    provenance: `profile:${accountId}`
  }
}

/** Removes an account's folder with its kept panes' file already pointing away from it. */
export async function removeClaudeAccountFolder(
  router: AccountRouter,
  accountId: string
): Promise<void> {
  router.accountPointers.retire(accountId)
  try {
    await router.removeAccount(accountId)
  } catch (error) {
    router.accountPointers.restore(accountId)
    throw error
  }
}

/** A kept launch on this host's router; refuses where none is installed rather than falling back. */
export function prepareInstalledClaudeLaunchForAccount(
  accountId: string | null
): Promise<ClaudeRuntimeAuthPreparation> {
  const router = getClaudeProfileRouter()
  return router
    ? prepareClaudeLaunchForAccount(router, accountId)
    : Promise.reject(keptAccountRefusals.accountRemoved())
}
