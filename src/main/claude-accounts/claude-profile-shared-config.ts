import { randomUUID } from 'node:crypto'
import { lstatSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { lock } from 'proper-lockfile'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import { updateClaudeGlobalConfig } from '../claude/claude-folder-trust-file'
import { getManagedScriptFileName, removeManagedHooks } from '../claude/hook-settings'
import { publishFileWithoutOverwrite, writeFileAtomically } from '../codex-accounts/fs-utils'
import { readClaudeProfileObject } from './claude-profile-paths'
import {
  ClaudeProfileSurfaceError,
  type ClaudeProfileSurfaceOutcome
} from './claude-profile-report'
import { copyClaudeProfileFile } from './claude-profile-sharing'
import {
  agreedHashes,
  applyUnlessChangedSince,
  hashUnits,
  isPlainRecord,
  reconcileSharedUnits,
  sameUnits,
  settingsUnits,
  stateUnits,
  withSettingsUnits,
  withStateUnits,
  type SharedHashes,
  type SharedUnits
} from './claude-profile-shared-units'

/** What both folders agreed on after the last reconcile, and which files that was. */
export type ClaudeSharedBase = {
  /** The user's Claude folder the account mirrors; another folder means no base. */
  source: string
  settings?: SharedHashes
  state?: SharedHashes
  /** Claude sets `firstStartTime` once per `.claude.json`; a new value means the file was recreated. */
  userStart?: string
  accountStart?: string
}

// Beside profile.json, outside the folder Claude reads.
function basePath(profileHome: string): string {
  return join(dirname(profileHome), 'shared-config.json')
}

function isHashes(value: unknown): value is SharedHashes {
  return isPlainRecord(value) && Object.values(value).every((hash) => typeof hash === 'string')
}

/** A missing, unreadable or other-source base reconciles like a first run: nothing is deleted. */
export function readClaudeSharedBase(profileHome: string, source: string): ClaudeSharedBase {
  const read = readClaudeProfileObject(basePath(profileHome))
  const value: Record<string, unknown> = read.kind === 'present' ? read.value : {}
  if (value.version !== 1 || value.source !== source) {
    return { source }
  }
  const text = (field: unknown) => (typeof field === 'string' ? field : undefined)
  return {
    source,
    settings: isHashes(value.settings) ? value.settings : undefined,
    state: isHashes(value.state) ? value.state : undefined,
    userStart: text(value.userStart),
    accountStart: text(value.accountStart)
  }
}

export function writeClaudeSharedBase(profileHome: string, base: ClaudeSharedBase): void {
  writeFileAtomically(basePath(profileHome), `${JSON.stringify({ version: 1, ...base })}\n`, {
    mode: 0o600
  })
}

type JsonFile =
  | { kind: 'present'; value: Record<string, unknown>; text: string; mode: number }
  | { kind: 'absent' }
  | { kind: 'unavailable' }

function readJsonFile(file: string): JsonFile {
  try {
    const text = readFileSync(file, 'utf8')
    const value: unknown = JSON.parse(text)
    return isPlainRecord(value)
      ? { kind: 'present', value, text, mode: statSync(file).mode & 0o777 }
      : { kind: 'unavailable' }
  } catch (error) {
    return isDefinitiveAbsence(error) ? { kind: 'absent' } : { kind: 'unavailable' }
  }
}

/** Skip the write if the file changed since it was read; the next refresh reconciles it. */
function writeJsonIfUnchanged(file: string, read: JsonFile, value: Record<string, unknown>): void {
  const now = readJsonFile(file)
  if (
    now.kind !== read.kind ||
    (now.kind === 'present' && read.kind === 'present' && now.text !== read.text)
  ) {
    throw new ClaudeProfileSurfaceError('locked', `${file} changed during the account refresh`)
  }
  writeFileAtomically(file, `${JSON.stringify(value, null, 2)}\n`, {
    mode: read.kind === 'present' ? read.mode : 0o600
  })
}

function sameTopLevel(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  const sorted = (value: Record<string, unknown>) =>
    JSON.stringify(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  return sorted(left) === sorted(right)
}

function withoutOrcaHooks(settings: Record<string, unknown>): string {
  return JSON.stringify(removeManagedHooks(settings, getManagedScriptFileName()).config.hooks)
}

/**
 * Reconcile the user's `settings.json` and an account's copy. `oneWay` also copies Orca's
 * hook and status-line keys from the user, for the account being set up.
 */
export function reconcileClaudeSharedSettings(args: {
  userFile: string
  accountFile: string
  base: SharedHashes | undefined
  oneWay: boolean
}): { outcome: ClaudeProfileSurfaceOutcome; base: SharedHashes | undefined } {
  if (lstatSync(args.accountFile, { throwIfNoEntry: false })?.isSymbolicLink()) {
    return { outcome: 'user-owned', base: args.base }
  }
  const user = readJsonFile(args.userFile)
  const account = readJsonFile(args.accountFile)
  if (user.kind === 'unavailable') {
    // Copy the bytes as before; Claude reports the broken file itself.
    return {
      outcome: args.oneWay ? copyClaudeProfileFile(args.userFile, args.accountFile) : 'unchanged',
      base: args.base
    }
  }
  if (account.kind === 'unavailable' && !args.oneWay) {
    return { outcome: 'unchanged', base: args.base }
  }
  const userValue: Record<string, unknown> = user.kind === 'present' ? user.value : {}
  const accountValue: Record<string, unknown> = account.kind === 'present' ? account.value : {}
  // Claude refuses to save settings through a link, so Orca doesn't either: those copy one way.
  const userLinked = lstatSync(args.userFile, { throwIfNoEntry: false })?.isSymbolicLink() === true
  // Claude never deletes settings.json, so only a missing account copy is not a deletion.
  const shared = userLinked
    ? settingsUnits(userValue)
    : reconcileSharedUnits(
        settingsUnits(userValue),
        settingsUnits(accountValue),
        args.base ?? null,
        {
          user: true,
          account: account.kind === 'present'
        }
      )
  let outcome: ClaudeProfileSurfaceOutcome = 'unchanged'
  let base = hashUnits(shared)
  if (!sameUnits(settingsUnits(userValue), shared)) {
    writeJsonIfUnchanged(args.userFile, user, withSettingsUnits(userValue, shared))
    const reread = readJsonFile(args.userFile)
    base = agreedHashes(shared, settingsUnits(reread.kind === 'present' ? reread.value : {}))
    outcome = 'merged'
  }
  // Compare without Orca's hooks: the installer adds them to the account after this copy.
  const oneWay = !args.oneWay
    ? accountValue
    : withoutOrcaHooks(userValue) === withoutOrcaHooks(accountValue)
      ? { hooks: accountValue.hooks, statusLine: userValue.statusLine }
      : userValue
  const accountNext = withSettingsUnits(oneWay, shared)
  if (account.kind === 'present' && sameTopLevel(accountNext, accountValue)) {
    return { outcome, base }
  }
  if (Object.keys(accountNext).length === 0 && user.kind === 'absent') {
    rmSync(args.accountFile, { force: true })
  } else if (account.kind !== 'absent' || Object.keys(accountNext).length > 0) {
    writeJsonIfUnchanged(args.accountFile, account, accountNext)
  } else {
    return { outcome, base }
  }
  return { outcome: outcome === 'unchanged' ? 'synced' : outcome, base }
}

/** Publish without replacing a file Claude created meanwhile. */
export function createJsonFile(file: string, value: Record<string, unknown>): boolean {
  const staged = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(staged, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    return publishFileWithoutOverwrite(staged, file)
  } finally {
    rmSync(staged, { force: true })
  }
}

function throwIfNotUpdated(outcome: string, file: string): void {
  if (outcome === 'locked' || outcome === 'unreadable') {
    throw new ClaudeProfileSurfaceError(outcome, `${file} is ${outcome}`)
  }
}

/**
 * Reconcile the shared values of the user's `.claude.json` with an account's. `copyRest` runs
 * after, against the user's latest config, for the one-way keys of the account being set up.
 */
export async function reconcileClaudeSharedState(args: {
  userFile: string
  accountFile: string
  base: ClaudeSharedBase
  copyRest?: (
    user: Record<string, unknown>,
    account: Record<string, unknown>
  ) => Record<string, unknown>
}): Promise<{ outcome: ClaudeProfileSurfaceOutcome; base: ClaudeSharedBase }> {
  const account = readClaudeProfileObject(args.accountFile)
  if (account.kind === 'unavailable') {
    throw new ClaudeProfileSurfaceError('unreadable', 'Profile Claude state is unreadable')
  }
  const accountRead = account.kind === 'present' ? stateUnits(account.value) : new Map()
  const accountStart =
    account.kind === 'present' && typeof account.value.firstStartTime === 'string'
      ? account.value.firstStartTime
      : undefined
  let shared: SharedUnits = new Map()
  let user: Record<string, unknown> = {}
  const userOutcome = await updateClaudeGlobalConfig(args.userFile, (current) => {
    user = current
    const userStart =
      typeof current.firstStartTime === 'string' ? current.firstStartTime : undefined
    // Claude sets firstStartTime once per file: a file it recreated, or Orca made and Claude
    // never started in, has no deletions to pass on.
    shared = reconcileSharedUnits(stateUnits(current), accountRead, args.base.state ?? null, {
      user: userStart !== undefined && userStart === args.base.userStart,
      account: accountStart !== undefined && accountStart === args.base.accountStart
    })
    if (sameUnits(stateUnits(current), shared)) {
      return { kind: 'unchanged' }
    }
    user = withStateUnits(current, shared)
    return { kind: 'changed', config: user }
  })
  throwIfNotUpdated(userOutcome, args.userFile)
  if (userOutcome === 'missing-config') {
    // A user who never ran Claude outside an account has no file yet: give it the shared values.
    if (accountRead.size === 0 || !createJsonFile(args.userFile, withStateUnits({}, accountRead))) {
      return { outcome: 'absent', base: args.base }
    }
    shared = accountRead
  }
  const reread = readClaudeProfileObject(args.userFile)
  const after: Record<string, unknown> = reread.kind === 'present' ? reread.value : {}
  const next: ClaudeSharedBase = {
    ...args.base,
    state: agreedHashes(shared, stateUnits(after)),
    userStart: typeof after.firstStartTime === 'string' ? after.firstStartTime : undefined,
    accountStart
  }
  if (account.kind === 'absent') {
    return { outcome: userOutcome === 'updated' ? 'merged' : 'unchanged', base: next }
  }
  const accountOutcome = await updateClaudeGlobalConfig(args.accountFile, (current) => {
    const rest = args.copyRest ? args.copyRest(user, current) : current
    const config = withStateUnits(
      rest,
      applyUnlessChangedSince(shared, stateUnits(current), accountRead)
    )
    return JSON.stringify(config) === JSON.stringify(current)
      ? { kind: 'unchanged' }
      : { kind: 'changed', config }
  })
  throwIfNotUpdated(accountOutcome, args.accountFile)
  const changed = userOutcome === 'updated' || accountOutcome === 'updated'
  return { outcome: changed ? 'merged' : 'unchanged', base: next }
}

/** Serialize reconciles across setup workers; a crashed holder's lock goes stale after 10 s. */
export async function withClaudeSharedConfigLock(
  profilesRoot: string,
  run: () => Promise<void>
): Promise<void> {
  const release = await lock(profilesRoot, {
    lockfilePath: join(profilesRoot, 'shared-config.lock'),
    realpath: false,
    retries: { retries: 20, minTimeout: 25, maxTimeout: 250 },
    onCompromised: () => {}
  })
  try {
    await run()
  } finally {
    await release().catch(() => {})
  }
}
