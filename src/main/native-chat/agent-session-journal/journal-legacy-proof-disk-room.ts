import { statfs } from 'node:fs/promises'
import { isDiskAlmostFull } from '../../../shared/diagnostics/perf-notice-signals'

/**
 * The proof converts every chat the store lacks before the old file can go, and the old file stays
 * meanwhile (a 20.8 GB file grew the store to 31 GB). Each page waits while the disk is almost full
 * rather than filling it; the proof resumes where it paused.
 */
export class JournalLegacyLowDiskError extends Error {
  constructor() {
    super('the disk is almost full, so converting old chats waits for free space')
    this.name = 'JournalLegacyLowDiskError'
  }
}

async function assertLegacyProofDiskRoom(directory: string): Promise<void> {
  let stats: Awaited<ReturnType<typeof statfs>>
  try {
    stats = await statfs(directory)
  } catch {
    // A volume that can't say how full it is doesn't hold the proof up.
    return
  }
  const block = Number(stats.bsize)
  if (
    isDiskAlmostFull({
      freeBytes: Number(stats.bavail) * block,
      totalBytes: Number(stats.blocks) * block
    })
  ) {
    throw new JournalLegacyLowDiskError()
  }
}

/** The proof's pacing gate, which also waits while the profile's disk is almost full. */
export function withLegacyProofDiskRoom(
  directory: string,
  boundary: () => Promise<boolean>
): () => Promise<boolean> {
  return async () => {
    if (!(await boundary())) {
      return false
    }
    await assertLegacyProofDiskRoom(directory)
    return true
  }
}
