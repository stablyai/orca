import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { listClaudeProfileHomes } from './claude-profile-homes'
import { readClaudeProfileObject } from './claude-profile-paths'
import { lstatIfPresent } from './claude-profile-prompt-history'
import {
  ClaudeProfileSurfaceError,
  runClaudeProfileSurface,
  warnClaudeProfile,
  type ClaudeProfileReport,
  type ClaudeProfileSurfaceOutcome
} from './claude-profile-report'
import {
  createJsonFile,
  readClaudeSharedBase,
  reconcileClaudeSharedSettings,
  reconcileClaudeSharedState,
  withClaudeSharedConfigLock,
  writeClaudeSharedBase,
  type ClaudeSharedBase
} from './claude-profile-shared-config'
import { stateUnits, withStateUnits } from './claude-profile-shared-units'

type CopyRest = (
  user: Record<string, unknown>,
  account: Record<string, unknown>
) => Record<string, unknown>

async function copyState(
  source: string,
  target: string,
  base: ClaudeSharedBase,
  copyRest: CopyRest
): Promise<{ outcome: ClaudeProfileSurfaceOutcome; base: ClaudeSharedBase }> {
  if (lstatIfPresent(target)?.isSymbolicLink()) {
    return { outcome: 'user-owned', base }
  }
  const input = readClaudeProfileObject(source)
  if (input.kind === 'unavailable') {
    throw new ClaudeProfileSurfaceError('unreadable', 'Personal Claude state is unreadable')
  }
  if (input.kind === 'absent' && !lstatIfPresent(target)) {
    return { outcome: 'absent', base }
  }
  const reconcile = () =>
    reconcileClaudeSharedState({ userFile: source, accountFile: target, base, copyRest })
  const result = await reconcile()
  const user = readClaudeProfileObject(source)
  if (lstatIfPresent(target) || user.kind !== 'present') {
    return result
  }
  // Publish without replacing a file Claude created concurrently.
  const created = createJsonFile(
    target,
    withStateUnits(copyRest(user.value, {}), stateUnits(user.value))
  )
  return created ? { ...result, outcome: 'synced' } : reconcile()
}

type SharedPaths = {
  source: string
  userSettings: string
  userState: string
  statePath: (configDir: string) => string
}

async function reconcileOtherAccount(home: string, paths: SharedPaths): Promise<void> {
  let base = readClaudeSharedBase(home, paths.source)
  base = {
    ...base,
    settings: reconcileClaudeSharedSettings({
      userFile: paths.userSettings,
      accountFile: join(home, 'settings.json'),
      base: base.settings,
      oneWay: false
    }).base
  }
  if (lstatIfPresent(paths.statePath(home))?.isFile()) {
    const state = await reconcileClaudeSharedState({
      userFile: paths.userState,
      accountFile: paths.statePath(home),
      base
    })
    base = state.base
  }
  writeClaudeSharedBase(home, base)
}

/**
 * Reconcile the user's settings and MCP servers with every prepared account on this host, this
 * account last, so a change saved under any account reaches the user's files and this account.
 */
export async function refreshClaudeProfileSharedConfig(args: {
  profileHome: string
  /** The user's own Claude folder. */
  defaultHome: string
  userState: string
  statePath: (configDir: string | undefined) => string
  /** Orca's data folder; without it only this account is reconciled. */
  dataRoot?: string
  firstSetup?: boolean
  report: ClaudeProfileReport
  /** Copies the one-way keys of this account's `.claude.json` from the user's latest config. */
  copyRest: CopyRest
}): Promise<void> {
  const { report, profileHome } = args
  const paths: SharedPaths = {
    source: resolve(args.defaultHome),
    userSettings: join(args.defaultHome, 'settings.json'),
    userState: args.userState,
    statePath: args.statePath
  }
  const others = args.dataRoot
    ? listClaudeProfileHomes(args.dataRoot).filter(
        (home) =>
          resolve(home) !== resolve(profileHome) && existsSync(join(dirname(home), 'profile.json'))
      )
    : []
  const reconcileSelf = async (): Promise<void> => {
    let base = readClaudeSharedBase(profileHome, paths.source)
    await runClaudeProfileSurface(report, 'settings.json', () => {
      const result = reconcileClaudeSharedSettings({
        userFile: paths.userSettings,
        accountFile: join(profileHome, 'settings.json'),
        base: base.settings,
        oneWay: true
      })
      base = { ...base, settings: result.base }
      return result.outcome
    })
    await runClaudeProfileSurface(report, '.claude.json', async () => {
      const result = await copyState(
        paths.userState,
        args.statePath(profileHome),
        base,
        args.copyRest
      )
      base = result.base
      return result.outcome
    })
    writeClaudeSharedBase(profileHome, base)
  }
  const lockRoot = args.dataRoot ? join(args.dataRoot, 'claude-profiles') : dirname(profileHome)
  try {
    await withClaudeSharedConfigLock(lockRoot, async () => {
      for (const home of others) {
        await reconcileOtherAccount(home, paths).catch((error: unknown) =>
          warnClaudeProfile(report, 'shared-config', error)
        )
      }
      await reconcileSelf()
    })
  } catch (error) {
    warnClaudeProfile(report, 'shared-config', error)
    // A first launch waits for setup, so it copies the user's config even while the lock is busy.
    if (args.firstSetup) {
      await reconcileSelf()
    }
    report.surfaces['settings.json'] ??= 'failed'
    report.surfaces['.claude.json'] ??= 'failed'
  }
}
