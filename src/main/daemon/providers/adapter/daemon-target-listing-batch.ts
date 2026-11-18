/** Joins target listings started in the same macrotask into one owner listing, so a sweep of
 *  panes on one owner costs one session listing; each caller gets only its own rows. */
export class DaemonTargetListingBatch<Row extends { id: string }> {
  private readonly open = new Map<
    number | undefined,
    { ids: Set<string>; rows: Promise<ReadonlyMap<string, Row>> }
  >()

  constructor(
    private readonly list: (ids: readonly string[], deadlineMs?: number) => Promise<readonly Row[]>
  ) {}

  async read(ids: readonly string[], deadlineMs?: number): Promise<Row[]> {
    const batch = this.open.get(deadlineMs) ?? this.openBatch(deadlineMs)
    for (const id of ids) {
      batch.ids.add(id)
    }
    const rows = await batch.rows
    return ids.flatMap((id) => {
      const row = rows.get(id)
      return row ? [row] : []
    })
  }

  private openBatch(deadlineMs: number | undefined) {
    const ids = new Set<string>()
    const rows = new Promise<void>((resolve) => setTimeout(resolve, 0)).then(async () => {
      this.open.delete(deadlineMs)
      const listed = await this.list([...ids], deadlineMs)
      return new Map(listed.map((row) => [row.id, row]))
    })
    const batch = { ids, rows }
    this.open.set(deadlineMs, batch)
    return batch
  }
}
