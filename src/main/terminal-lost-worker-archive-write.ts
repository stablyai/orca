import type { ArchivedTerminalTab } from '../shared/terminal-archive-types'
import { TerminalArchiveError } from './terminal-archive-failure'
import type {
  ArchiveTerminalTabRequest,
  LostTerminalArchiveRetirement
} from './terminal-archive-contracts'
import type { TerminalArchiveStore } from './terminal-archive-store'

export function writeLostWorkerTerminalArchive(
  store: TerminalArchiveStore,
  request: ArchiveTerminalTabRequest,
  retirement: LostTerminalArchiveRetirement
): Promise<{ archive: ArchivedTerminalTab; ptyIdsToKill: string[] }> {
  return store.archiveTerminalTabWithCommit(request, (archive, archives) => {
    const committed = store.commitLostTerminalArchiveAndRetire(archives, retirement)
    if (!committed) {
      throw new Error('lost-worker archive retirement is unavailable')
    }
    if (!committed.closed) {
      throw new TerminalArchiveError('stale-source')
    }
    return { archive, ptyIdsToKill: committed.ptyIdsToKill }
  })
}
