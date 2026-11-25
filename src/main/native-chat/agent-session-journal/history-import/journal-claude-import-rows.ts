import { Table, type IndexBudget } from './journal-claude-import-index-storage'

export const enum Row {
  Uuid,
  Flags,
  Previous,
  Next,
  Parent,
  Range,
  Message,
  Agent,
  SourceAssistant,
  Tool,
  Compact,
  Width
}

// Charged tables cannot reach the tagged half of the Uint32 address space.
const EXTENDED_ROW = 0x80000000
const PRECEDING_PARENT = 0xffffffff

/** Link-only rows share a dense sequence with visible rows. Other fields live in a sparse table. */
export class ClaudeImportRows {
  private readonly chain: Table
  private readonly details: Table

  constructor(budget: IndexBudget) {
    this.chain = new Table(Row.Parent + 1, budget)
    this.details = new Table(Row.Width - Row.Parent, budget)
  }

  get length(): number {
    return this.chain.length
  }

  dispose(): void {
    this.chain.dispose()
    this.details.dispose()
  }

  appendLink(uuid: number, parent: number, flags: number, progress: boolean): number {
    // Keep the preceding physical UUID so later duplicates still resolve through the key table.
    const link =
      progress && parent && parent === this.chain.get(this.length, Row.Uuid)
        ? PRECEDING_PARENT
        : parent
    return this.chain.append(uuid, flags, 0, 0, link)
  }

  appendRecord(
    uuid: number,
    parent: number,
    flags: number,
    range: number,
    message: number,
    agent: number,
    sourceAssistant: number,
    tool: number,
    compact: number
  ): number {
    const detail = this.details.append(
      parent,
      range,
      message,
      agent,
      sourceAssistant,
      tool,
      compact
    )
    return this.chain.append(uuid, flags, 0, 0, EXTENDED_ROW + detail)
  }

  get(row: number, column: Row): number {
    if (column < Row.Parent) {
      return this.chain.get(row, column)
    }
    const link = this.chain.get(row, Row.Parent)
    if (link === PRECEDING_PARENT) {
      return column === Row.Parent ? this.chain.get(row - 1, Row.Uuid) : 0
    }
    if (link >= EXTENDED_ROW) {
      return this.details.get(link - EXTENDED_ROW, column - Row.Parent)
    }
    return column === Row.Parent ? link : 0
  }

  set(row: number, column: Row.Flags | Row.Previous | Row.Next | Row.Parent, value: number): void {
    if (column === Row.Parent) {
      const link = this.chain.get(row, Row.Parent)
      if (link >= EXTENDED_ROW && link !== PRECEDING_PARENT) {
        this.details.set(link - EXTENDED_ROW, 0, value)
        return
      }
    }
    this.chain.set(row, column, value)
  }
}
