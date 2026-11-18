export type AdoptedRootProcess = { incarnationId: string | null; pid: number }

type ListedRoot = { id: string; incarnationId?: string; rootProcessId?: number }

/** Joins the root-PID lookups an idle sweep starts for old local owners into one target inventory,
 *  which an owner answers with a single session listing however many panes ask. */
export class AdoptedRootDiscovery {
  private open: { ids: Set<string>; rows: Promise<ReadonlyMap<string, ListedRoot>> } | null = null

  constructor(
    private readonly list: (ptyIds: readonly string[]) => Promise<readonly ListedRoot[]> | undefined
  ) {}

  find(ptyId: string): Promise<AdoptedRootProcess | null> {
    const batch = this.open ?? this.openBatch()
    batch.ids.add(ptyId)
    return batch.rows.then((rows) => {
      const row = rows.get(ptyId)
      return row?.rootProcessId
        ? { incarnationId: row.incarnationId ?? null, pid: row.rootProcessId }
        : null
    })
  }

  private async listOnce(ids: ReadonlySet<string>): Promise<readonly ListedRoot[] | undefined> {
    return await this.list([...ids])
  }

  private openBatch(): NonNullable<AdoptedRootDiscovery['open']> {
    const ids = new Set<string>()
    const rows = new Promise<void>((resolve) => setTimeout(resolve, 0)).then(async () => {
      this.open = null
      // Why once more: one pane's route changing mid-listing rejects the whole batch, and that pane
      // is settled by the retry, so it can't cost the healthy panes their read.
      const listed = await this.listOnce(ids).catch(() => this.listOnce(ids).catch(() => undefined))
      return new Map((listed ?? []).map((row) => [row.id, row]))
    })
    this.open = { ids, rows }
    return this.open
  }
}
