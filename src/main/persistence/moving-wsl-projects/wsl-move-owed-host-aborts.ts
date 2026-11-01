/**
 * A stage a reset move may have left on the WSL host. A reset without the host's answer (a restart
 * while the host is down) lifts the desktop's record but cannot abort the host's stage, which then
 * keeps its claims on those projects for the stage's 7-day lifetime and refuses every retry. The
 * reset leaves this record; the next move into the distro aborts that stage by identity first.
 */
import type { OrcadMigrationCatalogReferenceAbortResult } from '../../../shared/orcad-migration/orcad-migration-manifest'
import { isRecord } from '../../../shared/orcad-migration/orcad-migration-manifest-fields'
import type { WslMoveCutover } from '../../../shared/wsl-move/wsl-move-cutover'
import { createMigrationJournalDirectory } from '../migrating-orcad-catalog/migration-journal-directory'
import type { OrcadMigrationDestinationCatalog } from '../../ssh/orcad-migration-cutover-coordinator'

export type WslMoveOwedHostAbort = {
  migrationId: string
  manifestSha256: string
  journalKey: string
}

const owed = createMigrationJournalDirectory<WslMoveOwedHostAbort>({
  // Its own directory: builds without it never read it, and their stage simply expires.
  directoryName: 'orcad-migration-wsl-owed-aborts',
  maxFileBytes: 4096,
  parse: parseOwedAbort,
  unreadable: (detail) => new Error(`wsl_move_owed_aborts_unreadable: ${detail}`)
})

function parseOwedAbort(value: unknown): WslMoveOwedHostAbort {
  if (
    !isRecord(value) ||
    typeof value.migrationId !== 'string' ||
    typeof value.manifestSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.manifestSha256) ||
    typeof value.journalKey !== 'string'
  ) {
    throw new Error('wsl_move_owed_abort_invalid')
  }
  return {
    migrationId: value.migrationId,
    manifestSha256: value.manifestSha256,
    journalKey: value.journalKey
  }
}

/** Durable before it returns, so it lands before the record it outlives is removed. */
export function recordWslMoveOwedHostAbort(
  userDataPath: string,
  cutover: Pick<WslMoveCutover, 'migrationId' | 'manifestSha256' | 'journalKey'>
): void {
  owed.write(userDataPath, {
    migrationId: cutover.migrationId,
    manifestSha256: cutover.manifestSha256,
    journalKey: cutover.journalKey
  })
}

export function listWslMoveOwedHostAborts(userDataPath: string): WslMoveOwedHostAbort[] {
  return owed.list(userDataPath)
}

/**
 * Aborts each owed stage of this distro on its now-connected host. Only an answer settles one:
 * a failure keeps it for the next move, whose own stage the leftover would refuse anyway.
 */
export async function settleWslMoveOwedHostAborts(
  userDataPath: string,
  journalKey: string,
  destination: Pick<OrcadMigrationDestinationCatalog, 'abortByReference'>,
  warn: (message: string) => void = (message) => console.warn(message)
): Promise<void> {
  let pending: WslMoveOwedHostAbort[]
  try {
    pending = owed.list(userDataPath).filter((entry) => entry.journalKey === journalKey)
  } catch (error) {
    warn(`[wsl-move] Could not read the owed host aborts: ${describe(error)}`)
    return
  }
  for (const entry of pending) {
    let answer: OrcadMigrationCatalogReferenceAbortResult
    try {
      answer = await destination.abortByReference(entry)
    } catch (error) {
      warn(`[wsl-move] Could not abort a leftover stage on the host: ${describe(error)}`)
      continue
    }
    if (answer.state === 'committed') {
      // No commit was ever requested for it; leave the host's state alone and stop asking.
      warn(`[wsl-move] A reset move ${entry.migrationId} reads as committed on the host`)
    }
    owed.remove(userDataPath, entry.migrationId)
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
