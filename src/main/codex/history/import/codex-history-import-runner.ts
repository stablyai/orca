import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { normalizeRuntimePathForComparison } from '../../../../shared/file-access/cross-platform-path'
import type { GlobalSettings } from '../../../../shared/settings/global-settings-types'
import { isCodexHistorySharedAcrossAccounts } from '../../../codex-accounts/runtime-home/routing/codex-history-sharing'
import {
  getOrcaUserDataPath,
  getSystemCodexHomePath
} from '../../configuration/homes/codex-home-paths'
import { resolveHostCodexSessionSourceHome } from '../rollouts/codex-session-source-home'
import { isCodexAccountHistoryWorkStopping } from '../shared-store/codex-account-history-index'
import { importCodexHistory } from './codex-history-import'
import { forgetStoreFoldersWithoutHardLinks } from './codex-history-import-staging'

// Launches and selections within this of the last import don't read the folder again.
const IMPORT_INTERVAL_MS = 10 * 60_000
// A pause this long between publishes lets the index heal run, at most once a minute: each heal
// may start a Codex app-server.
const PUBLISH_HEAL_DELAY_MS = 2_000
const PUBLISH_HEAL_INTERVAL_MS = 60_000
// Names this run's staged copies, so a sweep never removes one still to be published.
const IMPORT_RUN_ID = randomUUID().replaceAll('-', '').slice(0, 12)
const IMPORT_LEDGER_PATH = (): string =>
  join(getOrcaUserDataPath(), 'codex-account-history', 'import-ledger.json')

export type CodexHistoryImportSettings = Pick<
  GlobalSettings,
  'codexSessionSourceHome' | 'codexShareHistoryAcrossAccounts'
>

// The folder to import from, or null while there is none or history isn't shared.
function resolveImportHome(settings: CodexHistoryImportSettings): string | null {
  const importHome = resolveHostCodexSessionSourceHome(settings)
  return importHome && isCodexHistorySharedAcrossAccounts(settings) ? importHome : null
}

export type CodexHistoryImportHost = {
  indexPendingDir: () => string
  /** Runs a publish job in the history queue as a pass, so the index heal waits for it. */
  publish: <T>(job: () => Promise<T>) => Promise<T>
  waitForLaunches: () => Promise<void>
  requestIndexHeal: () => void
  /** After an import finishes. */
  imported: () => void
}

/**
 * Copies the import folder's conversations that ~/.codex lacks into it: at most once per
 * interval, unless the setting changed. Copies are made outside the history queue, pausing while
 * a launch waits, and each is published by a short job in it. One import runs at a time: a
 * setting change during one starts another once it ends, which waits for a read stuck on a
 * frozen import folder.
 */
export class CodexHistoryImportRunner {
  private readonly importedAt = new Map<string, number>()
  private importing: Promise<void> | null = null
  private importAgain = false
  private publishHealTimer: ReturnType<typeof setTimeout> | undefined
  private publishHealAt = -Infinity

  constructor(private readonly host: CodexHistoryImportHost) {}

  importHistory(
    getSettings: () => CodexHistoryImportSettings,
    options: { settingChanged?: boolean } = {}
  ): Promise<void> {
    if (options.settingChanged) {
      forgetStoreFoldersWithoutHardLinks()
      this.importedAt.clear()
    }
    if (this.importing) {
      this.importAgain ||= options.settingChanged === true
      return this.importing
    }
    const importing = (async () => {
      do {
        this.importAgain = false
        await this.importOnce(getSettings)
      } while (this.importAgain)
    })()
    this.importing = importing.finally(() => {
      this.importing = null
    })
    return this.importing
  }

  private async importOnce(getSettings: () => CodexHistoryImportSettings): Promise<void> {
    const importHome = resolveImportHome(getSettings())
    if (!importHome) {
      return
    }
    const key = normalizeRuntimePathForComparison(importHome)
    if (Date.now() - (this.importedAt.get(key) ?? -Infinity) < IMPORT_INTERVAL_MS) {
      return
    }
    try {
      const copied = await importCodexHistory({
        importHome,
        storeHome: getSystemCodexHomePath(),
        ledgerPath: IMPORT_LEDGER_PATH(),
        indexPendingDir: this.host.indexPendingDir(),
        runId: IMPORT_RUN_ID,
        isCurrent: () =>
          !isCodexAccountHistoryWorkStopping() && resolveImportHome(getSettings()) === importHome,
        waitForLaunches: this.host.waitForLaunches,
        publish: async (job) => {
          const published = await this.host.publish(job)
          this.healAfterPublishes()
          return published
        }
      })
      if (copied !== null) {
        this.importedAt.set(key, Date.now())
      }
    } catch (error) {
      console.warn('[codex-history-import] Importing Codex conversations failed:', error)
    }
    this.host.imported()
  }

  // Indexes what was published once publishing pauses, so a later copy stuck on a frozen import
  // folder can't leave earlier conversations out of the index.
  private healAfterPublishes(): void {
    clearTimeout(this.publishHealTimer)
    const wait = Math.max(
      PUBLISH_HEAL_DELAY_MS,
      this.publishHealAt + PUBLISH_HEAL_INTERVAL_MS - Date.now()
    )
    this.publishHealTimer = setTimeout(() => {
      this.publishHealAt = Date.now()
      this.host.requestIndexHeal()
    }, wait)
  }
}
