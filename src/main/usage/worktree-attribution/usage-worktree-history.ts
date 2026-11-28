import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { lazyZodSchema } from '../../../shared/schema/lazy-zod-schema'
import type { Repo } from '../../../shared/repository/repo-types'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import { UsageCacheSnapshotWriter } from '../cache/usage-cache-snapshot-writer'
import type { UsageWorktreeSource } from './usage-worktree-metadata'

type HistoryStore = Pick<UsageWorktreeSource, 'getRepos' | 'getAllWorktreeMeta'> & {
  onWorktreeMetaWritten: (listener: (write: { worktreeId: string }) => void) => () => void
}

const historyFileSchema = lazyZodSchema(() =>
  z.object({
    schemaVersion: z.literal(1),
    worktrees: z.array(z.tuple([z.string(), z.string()]))
  })
)

/** Remembers every worktree Orca has had, so removing one keeps its sessions in the Orca usage scope. */
export class UsageWorktreeHistory implements UsageWorktreeSource {
  private readonly displayNames = new Map<string, string>()
  private readonly writer: UsageCacheSnapshotWriter
  private readonly loaded: Promise<void>
  private writable = true

  constructor(
    private readonly store: HistoryStore,
    file: string
  ) {
    this.writer = new UsageCacheSnapshotWriter('[usage-worktree-history]', () => file)
    const allMeta = store.getAllWorktreeMeta()
    for (const worktreeId in allMeta) {
      if (Object.hasOwn(allMeta, worktreeId)) {
        this.remember(worktreeId, allMeta[worktreeId].displayName)
      }
    }
    // Record on every metadata write: worktrees are often created and deleted between usage scans.
    // Read the live row, not the event: another host's write leaves the local row unchanged.
    store.onWorktreeMetaWritten(({ worktreeId }) => {
      const live = store.getAllWorktreeMeta()[worktreeId]
      if (live && this.remember(worktreeId, live.displayName)) {
        this.persist()
      }
    })
    this.loaded = readHistoryFile(file).then((saved) => {
      if (!saved) {
        this.writable = false
        return
      }
      for (const [worktreeId, displayName] of saved) {
        // Names recorded since startup are newer than the file's.
        if (!this.displayNames.has(worktreeId)) {
          this.displayNames.set(worktreeId, displayName)
        }
      }
      for (const [worktreeId, name] of this.displayNames) {
        if (saved.get(worktreeId) !== name) {
          this.write()
          break
        }
      }
    })
  }

  getRepos(): Repo[] {
    return this.store.getRepos()
  }

  getAllWorktreeMeta(): Record<string, Pick<WorktreeMeta, 'displayName'>> {
    return this.store.getAllWorktreeMeta()
  }

  getRememberedWorktreeDisplayNames(): ReadonlyMap<string, string> {
    return this.displayNames
  }

  whenLoaded(): Promise<void> {
    return this.loaded
  }

  async flush(): Promise<void> {
    await this.loaded
    await this.writer.flush()
  }

  private remember(worktreeId: string, displayName: string | undefined): boolean {
    const name = displayName ?? ''
    if (this.displayNames.get(worktreeId) === name) {
      return false
    }
    this.displayNames.set(worktreeId, name)
    return true
  }

  private persist(): void {
    // Wait for the saved file, or this write would drop the worktrees only it remembers.
    void this.loaded.then(() => this.write())
  }

  private write(): void {
    if (!this.writable) {
      return
    }
    void this.writer
      .write(() => JSON.stringify({ schemaVersion: 1, worktrees: [...this.displayNames] }))
      .catch(() => {})
  }
}

/** Null when the file exists but can't be read or is from a newer build, so it is never overwritten. */
async function readHistoryFile(file: string): Promise<Map<string, string> | null> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT' ? new Map() : null
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    // Unparseable: start over so the history can heal.
    return new Map()
  }
  const parsed = historyFileSchema.safeParse(json)
  return parsed.success ? new Map(parsed.data.worktrees) : null
}
