import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { CLAUDE_REMOVED_ACCOUNT_POINTER } from '../../shared/claude-profile-routing'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import { findClaudeAccount } from './runtime-selection'

function isDefinitivelyAbsent(path: string): boolean {
  try {
    lstatSync(path)
    return false
  } catch (error) {
    return isDefinitiveAbsence(error)
  }
}

const ACCOUNT_PREFIX = 'account-'
const SYSTEM_DEFAULT_FILE = 'system-default'
const ACCOUNT_ID = /^[a-zA-Z0-9_-]+$/

type AccountFolders = {
  accountHome: (accountId: string) => string
  coveredBySystemDefault: (accountId: string) => boolean
}

/** One which-account file per account, read by `claude` in panes started kept on it; never deleted, since a missing file reads as System default. */
export class ClaudeAccountPointers {
  readonly root: string
  /** Account ids with a file on disk; read once, so people who never kept anything pay nothing. */
  private existing: Set<string> | null = null
  /** Accounts being removed: nothing may point their files back at a folder that is going away. */
  private readonly retired = new Set<string>()

  constructor(
    readonly dataRoot: string,
    private readonly folders: AccountFolders,
    private readonly getSettings: () => Pick<GlobalSettings, 'claudeManagedAccounts'>
  ) {
    this.root = join(dataRoot, 'claude-profile-pointers')
  }

  pointerPath(accountId: string | null): string {
    if (accountId === null) {
      return join(this.root, SYSTEM_DEFAULT_FILE)
    }
    if (!ACCOUNT_ID.test(accountId)) {
      throw new Error('Invalid Claude account id')
    }
    return join(this.root, `${ACCOUNT_PREFIX}${accountId}`)
  }

  /** The folder an account's launches run in; '' when System default covers it, null when not saved. */
  routeFor(accountId: string): string | null {
    if (!findClaudeAccount(this.getSettings(), accountId)) {
      return null
    }
    return this.folders.coveredBySystemDefault(accountId) ? '' : this.folders.accountHome(accountId)
  }

  /** Writes the account's current route; a removed account's file keeps its placeholder. */
  update(accountId: string | null): void {
    if (accountId !== null && this.retired.has(accountId)) {
      return
    }
    const route = accountId === null ? '' : this.routeFor(accountId)
    if (route === null) {
      return
    }
    this.writeContent(accountId, route)
  }

  /** Called whenever the selection file is written, so a route change reaches kept panes too. */
  refreshExisting(): void {
    for (const accountId of this.listExisting()) {
      const route = this.retired.has(accountId) ? null : this.routeFor(accountId)
      if (route === null) {
        continue
      }
      try {
        this.writeContent(accountId, route)
      } catch (error) {
        // Why: one kept account's file must never fail the selection's own launches.
        console.warn('[claude-profile] Could not refresh a kept account pointer:', error)
      }
    }
  }

  isRetired(accountId: string): boolean {
    return this.retired.has(accountId)
  }

  /** Before an account's folder goes, its file names no folder, so a re-typed `claude` starts nothing. */
  retire(accountId: string): void {
    this.retired.add(accountId)
    if (!this.listExisting().has(accountId) && isDefinitivelyAbsent(this.pointerPath(accountId))) {
      return
    }
    this.writeContent(accountId, CLAUDE_REMOVED_ACCOUNT_POINTER)
  }

  /** A removal that failed leaves the account saved, so its kept agents point at it again. */
  restore(accountId: string): void {
    if (this.retired.delete(accountId) && this.listExisting().has(accountId)) {
      this.update(accountId)
    }
  }

  private listExisting(): Set<string> {
    if (!this.existing) {
      let names: string[] = []
      try {
        names = readdirSync(this.root)
      } catch {
        names = []
      }
      this.existing = new Set(
        names
          .filter((name) => name.startsWith(ACCOUNT_PREFIX))
          .map((name) => name.slice(ACCOUNT_PREFIX.length))
          .filter((id) => ACCOUNT_ID.test(id))
      )
    }
    return this.existing
  }

  private writeContent(accountId: string | null, content: string): void {
    const path = this.pointerPath(accountId)
    // Why compare first: launches re-sync these, and most find them unchanged.
    if (!existsSync(path) || readFileSync(path, 'utf8') !== content) {
      mkdirSync(this.root, { recursive: true, mode: 0o700 })
      writeFileAtomically(path, content, { mode: 0o600 })
    }
    if (accountId !== null) {
      this.listExisting().add(accountId)
    }
  }
}
