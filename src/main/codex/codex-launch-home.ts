import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import { safeRemoveTree } from '../pty/overlay-mirror'
import { resolveHostCodexManagedHomeVerdict } from '../codex-accounts/host-codex-managed-home-ownership'
import {
  getOrcaUserDataPath,
  getSystemCodexHomePath,
  syncSystemCodexResourcesIntoManagedHome
} from './codex-home-paths'
import { syncSystemConfigIntoManagedCodexHome } from './codex-config-mirror'
import { canonicalCodexHome, codexConversationStore } from './codex-conversation-store-path'

export { canonicalCodexHome, codexConversationStore }

export const CODEX_STORE_DIRECTORIES = [
  'sessions',
  'archived_sessions',
  'thread-writer-locks',
  '.tmp',
  'rollout-migrations'
] as const
const AUTH_IDENTITY = '.orca-linked-auth'

/** The login remains in its original account folder even when CODEX_HOME is an overlay. */
export function codexLoginHome(home: string, systemHome = getSystemCodexHomePath()): string {
  if (basename(dirname(home)) !== 'overlays') {
    return home
  }
  const account = dirname(dirname(home))
  return basename(account) === 'system' ? systemHome : join(account, 'home')
}

export function codexAccountOverlayHomes(accountDirectory: string): string[] {
  try {
    return readdirSync(join(accountDirectory, 'overlays'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^[a-f0-9]{32}$/.test(entry.name))
      .map((entry) => join(accountDirectory, 'overlays', entry.name))
  } catch (error) {
    if (!isDefinitiveAbsence(error)) {
      throw error
    }
    return []
  }
}

/** Removed accounts still own stores; settings are deliberately not the inventory. */
export function discoverCodexStoreHomes(
  accountsRoot = join(getOrcaUserDataPath(), 'codex-accounts')
): string[] {
  const homes: string[] = []
  let accounts: string[]
  try {
    accounts = readdirSync(accountsRoot)
  } catch (error) {
    if (!isDefinitiveAbsence(error)) {
      throw error
    }
    return homes
  }
  for (const id of accounts) {
    const home = join(accountsRoot, id, 'home')
    const verdict = resolveHostCodexManagedHomeVerdict({
      candidatePath: home,
      managedAccountsRoot: accountsRoot,
      systemCodexHomePath: getSystemCodexHomePath(),
      expectedAccountId: id
    })
    if (verdict.kind === 'indeterminate') {
      throw verdict.error
    }
    if (verdict.kind === 'owned') {
      homes.push(home)
    } else if (id !== 'system') {
      continue
    }
    for (const overlay of codexAccountOverlayHomes(join(accountsRoot, id))) {
      homes.push(overlay)
      try {
        homes.push(codexConversationStore(overlay))
      } catch (error) {
        if (!isDefinitiveAbsence(error)) {
          throw error
        }
      }
    }
  }
  return [...new Set(homes)]
}

export type CodexLaunchHomeOptions = {
  /** Null selects the system login. Managed homes are ownership-checked by the caller. */
  selectedAccount: { homePath: string } | null
  conversationHome?: string | null
  storeHome?: string
  systemHome?: string
  accountsRoot?: string
  /** Catalog reads derive exactly the launch path without creating it. */
  readOnly?: boolean
}

/** Every local launch and record-aware read resolves login + store through this entry point. */
export function resolveCodexLaunchHome(options: CodexLaunchHomeOptions): string | undefined {
  const systemHome = options.systemHome ?? getSystemCodexHomePath()
  if (!options.selectedAccount && !existsSync(join(systemHome, 'auth.json'))) {
    return undefined
  }
  const loginHome = options.selectedAccount?.homePath ?? systemHome
  const store = codexConversationStore(options.conversationHome ?? options.storeHome ?? systemHome)
  const accountDirectory = options.selectedAccount
    ? dirname(loginHome)
    : join(options.accountsRoot ?? join(getOrcaUserDataPath(), 'codex-accounts'), 'system')
  if (!options.readOnly) {
    reconcileCodexOverlaySignOut(accountDirectory, loginHome)
  }
  if (store === canonicalCodexHome(loginHome)) {
    return options.selectedAccount ? loginHome : undefined
  }
  const hash = createHash('sha256').update(store).digest('hex').slice(0, 32)
  const overlay = join(accountDirectory, 'overlays', hash)
  if (options.readOnly) {
    return overlay
  }
  materializeCodexOverlay(overlay, store, loginHome, systemHome)
  return overlay
}

function loginIdentity(loginHome: string): string | null {
  try {
    const value = statSync(join(loginHome, 'auth.json'))
    return JSON.stringify([value.dev, value.ino, value.size, value.mtimeMs])
  } catch (error) {
    if (!isDefinitiveAbsence(error)) {
      throw error
    }
    return null
  }
}

function unlinkIfPresent(path: string): void {
  try {
    unlinkSync(path)
  } catch (error) {
    if (!isDefinitiveAbsence(error)) {
      throw error
    }
  }
}

/** A logout predating re-auth must never erase the new login. */
export function reconcileCodexOverlaySignOut(accountDirectory: string, loginHome: string): void {
  const overlays = codexAccountOverlayHomes(accountDirectory)
  const identity = loginIdentity(loginHome)
  if (!identity) {
    return
  }
  for (const overlay of overlays) {
    if (existsSync(join(overlay, 'auth.json'))) {
      continue
    }
    let linkedIdentity: string
    try {
      linkedIdentity = readFileSync(join(overlay, AUTH_IDENTITY), 'utf8')
    } catch (error) {
      if (!isDefinitiveAbsence(error)) {
        throw error
      }
      continue
    }
    if (linkedIdentity !== identity) {
      continue
    }
    unlinkIfPresent(join(loginHome, 'auth.json'))
    for (const home of overlays) {
      unlinkIfPresent(join(home, 'auth.json'))
      unlinkIfPresent(join(home, 'auth.lock'))
      unlinkIfPresent(join(home, AUTH_IDENTITY))
    }
    return
  }
}

function linkLogin(home: string, loginHome: string): void {
  // Codex refreshes in place under auth.lock; path links also survive Orca's atomic re-auth.
  writeFileSync(join(loginHome, 'auth.lock'), '', { flag: 'a', mode: 0o600 })
  for (const entry of ['auth.json', 'auth.lock']) {
    const source = join(loginHome, entry)
    const target = join(home, entry)
    if (process.platform === 'win32') {
      if (!existsSync(source)) {
        unlinkIfPresent(target)
        continue
      }
      if (existsSync(target)) {
        const a = statSync(source),
          b = statSync(target)
        if (a.dev === b.dev && a.ino === b.ino) {
          continue
        }
      }
      unlinkIfPresent(target)
      linkSync(source, target)
    } else if (!existsSync(target)) {
      unlinkIfPresent(target)
      symlinkSync(source, target, 'file')
    }
  }
  const identity = loginIdentity(loginHome)
  if (identity) {
    writeFileSync(join(home, AUTH_IDENTITY), identity, { mode: 0o600 })
  }
}

function materializeCodexOverlay(
  overlay: string,
  store: string,
  loginHome: string,
  systemHome: string
): void {
  mkdirSync(dirname(overlay), { recursive: true })
  if (!existsSync(overlay)) {
    const staging = `${overlay}.creating-${randomUUID()}`
    mkdirSync(staging)
    try {
      for (const entry of CODEX_STORE_DIRECTORIES) {
        mkdirSync(join(store, entry), { recursive: true })
        symlinkSync(
          join(store, entry),
          join(staging, entry),
          process.platform === 'win32' ? 'junction' : 'dir'
        )
      }
      linkLogin(staging, loginHome)
      syncSystemCodexResourcesIntoManagedHome(staging)
      syncSystemConfigIntoManagedCodexHome({ runtimeHomePath: staging, systemHomePath: systemHome })
      try {
        renameSync(staging, overlay)
      } catch (error) {
        if (!existsSync(overlay)) {
          throw error
        }
      }
    } finally {
      safeRemoveTree(staging)
    }
  }
  linkLogin(overlay, loginHome)
  syncSystemCodexResourcesIntoManagedHome(overlay)
  syncSystemConfigIntoManagedCodexHome({ runtimeHomePath: overlay, systemHomePath: systemHome })
}

/** A probe may precede the first launch; materialize the same derived route before it spawns. */
export function prepareCodexCatalogHome(
  homePath: string,
  options: CodexLaunchHomeOptions,
  knownHomes: readonly string[]
): void {
  for (const store of [options.storeHome ?? getSystemCodexHomePath(), ...knownHomes]) {
    if (
      resolveCodexLaunchHome({ ...options, conversationHome: store, readOnly: true }) === homePath
    ) {
      resolveCodexLaunchHome({
        ...options,
        conversationHome: existsSync(homePath) ? homePath : store
      })
      return
    }
  }
}
