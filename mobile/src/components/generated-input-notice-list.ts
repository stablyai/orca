import type { GeneratedAgentInputNotice } from '../../../src/shared/generated-agent-input-notice'

export type ShownGeneratedInputNotice = { key: string; notice: GeneratedAgentInputNotice }

/** Live ranks over append slots let the phone read only its visible rows, including after Dismiss. */
export class GeneratedInputNoticeList {
  private slots: (ShownGeneratedInputNotice | null)[] = []
  private tree: number[] = [0]
  private readonly positions = new Map<string, number>()
  private prompts = 0
  revision = 0
  visits = 0

  get size(): number {
    return this.positions.size
  }

  get promptCount(): number {
    return this.prompts
  }

  replace(notices: readonly GeneratedAgentInputNotice[], session: string): void {
    const previous = this.slots
    const positions = new Map(this.positions)
    this.install(
      notices.map((notice) => {
        const position = positions.get(notice.id)
        const kept = position === undefined ? null : previous[position]
        const key = `${session}:${notice.id}`
        return kept?.key === key && sameNotice(kept.notice, notice) ? kept : { key, notice }
      })
    )
    this.revision += 1
  }

  add(notice: GeneratedAgentInputNotice, session: string): boolean {
    const position = this.positions.get(notice.id)
    const key = `${session}:${notice.id}`
    if (position !== undefined) {
      const kept = this.slots[position]!
      if (kept.key === key && sameNotice(kept.notice, notice)) {
        return false
      }
      this.prompts += Number(notice.submitted !== false) - Number(kept.notice.submitted !== false)
      this.slots[position] = { key, notice }
    } else {
      this.positions.set(notice.id, this.slots.length)
      const length = this.slots.push({ key, notice })
      this.prompts += Number(notice.submitted !== false)
      // A new aggregate node includes earlier slots in its range, not just the appended row.
      this.tree.push(1 + this.prefix(length - 1) - this.prefix(length - (length & -length)))
    }
    this.revision += 1
    return true
  }

  dismiss(id: string): boolean {
    const position = this.positions.get(id)
    if (position === undefined) {
      return false
    }
    this.prompts -= Number(this.slots[position]!.notice.submitted !== false)
    this.slots[position] = null
    this.positions.delete(id)
    for (let index = position + 1; index < this.tree.length; index += index & -index) {
      this.visits += 1
      this.tree[index] -= 1
    }
    if (this.slots.length > 2 * this.size + 16) {
      this.install(this.slots.filter((row): row is ShownGeneratedInputNotice => row !== null))
    }
    this.revision += 1
    return true
  }

  /** Newest first, selecting a live rank without walking removed slots. */
  at(index: number): ShownGeneratedInputNotice | undefined {
    if (index < 0 || index >= this.size) {
      return undefined
    }
    let wanted = this.size - index
    let before = 0
    let step = 1
    while (step * 2 < this.tree.length) {
      step *= 2
    }
    for (; step > 0; step = Math.floor(step / 2)) {
      const next = before + step
      this.visits += 1
      if (next < this.tree.length && this.tree[next] < wanted) {
        before = next
        wanted -= this.tree[next]
      }
    }
    return this.slots[before] ?? undefined
  }

  private prefix(end: number): number {
    let count = 0
    for (let index = end; index > 0; index -= index & -index) {
      this.visits += 1
      count += this.tree[index]
    }
    return count
  }

  private install(rows: ShownGeneratedInputNotice[]): void {
    this.slots = rows
    this.positions.clear()
    this.prompts = 0
    this.tree = Array.from({ length: rows.length + 1 }, () => 0)
    for (let index = 1; index <= rows.length; index += 1) {
      this.visits += 1
      const row = rows[index - 1]
      this.positions.set(row.notice.id, index - 1)
      this.prompts += Number(row.notice.submitted !== false)
      this.tree[index] += 1
      const parent = index + (index & -index)
      if (parent < this.tree.length) {
        this.tree[parent] += this.tree[index]
      }
    }
  }
}

function sameNotice(a: GeneratedAgentInputNotice, b: GeneratedAgentInputNotice): boolean {
  return (
    a.text === b.text &&
    a.agent === b.agent &&
    a.certainty === b.certainty &&
    a.submitted === b.submitted &&
    a.ptyId === b.ptyId &&
    a.handle === b.handle &&
    a.worktreeId === b.worktreeId
  )
}
