import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  CLAUDE_INJECTED_CONFIG_DIR_ENV,
  CLAUDE_PROFILE_POINTER_ENV
} from '../../../../shared/claude-profile-routing'
import { writeFileAtomically } from '../../../filesystem/atomic-file-publication'
import type { ClaudeProfileDescriptor } from '../claude-profile-paths'
import type { ClaudeEnvPatch } from '../../runtime-auth/environment'
import type { ClaudeRuntimeAuthPreparation } from '../../runtime-auth/runtime-auth-types'
import { isDirectory } from '../claude-profile-homes'
import { claudeProfileMissing } from './claude-profile-launch-errors'
import { prepareClaudeProfileForLaunch } from './claude-profile-launch-preparation'
import type { ClaudeProfileRouter } from './claude-profile-router'

type PinRouter = Pick<
  ClaudeProfileRouter,
  | 'pointerPath'
  | 'envReady'
  | 'describe'
  | 'setUp'
  | 'setUpInBackground'
  | 'savedAccount'
  | 'coveredBySystemDefault'
  | 'systemDefaultHome'
  | 'args'
>

/** A worktree pinned to a saved account keeps it whatever the selection becomes (#9496). */
export function pinnedClaudeProfile(
  router: Pick<ClaudeProfileRouter, 'args' | 'savedAccount' | 'describe'>,
  worktreeId: string | undefined
): ClaudeProfileDescriptor | null {
  const pins = router.args.getSettings().claudeAccountPinsByWorktree
  const accountId = worktreeId ? pins?.[worktreeId] : undefined
  return accountId && router.savedAccount(accountId) ? router.describe(accountId) : null
}

/** A pinned worktree's launch, or null to follow the selection: its own folder, or System default when that login covers it. */
export async function preparePinnedClaudeLaunch(
  router: PinRouter,
  worktreeId: string | undefined
): Promise<ClaudeRuntimeAuthPreparation | null> {
  const pinned = pinnedClaudeProfile(router, worktreeId)
  if (!pinned) {
    return null
  }
  await router.envReady
  const own = router.coveredBySystemDefault(pinned.accountId) ? null : pinned
  if (own) {
    await prepareClaudeProfileForLaunch(
      own,
      (value) => router.setUp(value),
      router.args.refreshWaitMs
    )
    if (!isDirectory(own.home)) {
      throw claudeProfileMissing()
    }
  }
  return {
    configDir: own?.home ?? router.systemDefaultHome(),
    runtime: 'host',
    wslDistro: null,
    wslLinuxConfigDir: null,
    envPatch: own
      ? { CLAUDE_CONFIG_DIR: own.home, [CLAUDE_INJECTED_CONFIG_DIR_ENV]: own.home }
      : {},
    provenance: own ? `profile:${own.accountId}` : 'system'
  }
}

/** Each pinned worktree reads its own pointer (empty is System default), so moving the selection pointer never reaches it. */
export function pinnedClaudeTerminalEnv(
  router: PinRouter,
  base: ClaudeEnvPatch,
  worktreeId: string | undefined
): ClaudeEnvPatch | null {
  const pinned = pinnedClaudeProfile(router, worktreeId)
  if (!pinned || !worktreeId) {
    return null
  }
  const path = join(
    dirname(router.pointerPath),
    'worktrees',
    createHash('sha256').update(worktreeId).digest('hex').slice(0, 32)
  )
  try {
    const home = router.coveredBySystemDefault(pinned.accountId) ? '' : pinned.home
    if (!existsSync(path) || readFileSync(path, 'utf8') !== home) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      writeFileAtomically(path, home, { mode: 0o600 })
    }
    router.setUpInBackground(pinned)
    return { ...base, [CLAUDE_PROFILE_POINTER_ENV]: path }
  } catch {
    // A broken pin must not prevent opening a terminal.
    return base
  }
}
