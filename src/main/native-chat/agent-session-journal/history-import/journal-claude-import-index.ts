import { ClaudeImportRows, Row } from './journal-claude-import-rows'
import { asRecord } from '../../../ai-vault/parsing/session-record-fields'
import {
  Flag,
  IndexBudget,
  Key,
  Keys,
  Link,
  Position,
  RangeData,
  Table
} from './journal-claude-import-index-storage'
import { selectClaudeImportRows } from './journal-claude-import-selection'
import type { ClaudeRange } from './journal-claude-import-source'

export class ClaudeImportIndex {
  private readonly budget = new IndexBudget()
  private readonly ids = new Keys(this.budget)
  private readonly rows = new ClaudeImportRows(this.budget)
  private readonly positions = new Table(Position.Width, this.budget, Float64Array)
  private readonly rangeData = new Table(RangeData.Width, this.budget)
  private readonly keys = this.ids.table
  private readonly links = new Table(Link.Width, this.budget)
  private hasQueuedPrompts = false
  private previousUuid: { value: string; key: number } | undefined

  dispose(): void {
    this.ids.dispose()
    this.rows.dispose()
    this.positions.dispose()
    this.rangeData.dispose()
    this.links.dispose()
    this.previousUuid = undefined
  }

  record(record: Record<string, unknown>, range: ClaudeRange): void {
    const { type, subtype } = record
    if (
      type !== 'user' &&
      type !== 'assistant' &&
      type !== 'system' &&
      type !== 'attachment' &&
      type !== 'progress'
    ) {
      return
    }
    const hidden = record.isSidechain === true || Boolean(record.teamName)
    const progress = type === 'progress'
    const uuid = this.ids.intern(record.uuid)
    // A boundary with a null physical parent ends the chain unless its preserved segment rejoins it.
    const boundary = uuid !== 0 && type === 'system' && subtype === 'compact_boundary'
    const compact = boundary ? this.compact(record) : 0
    if (hidden || progress) {
      if (uuid) {
        const parent = this.parentKey(record, uuid)
        const row = compact
          ? this.rows.appendRecord(uuid, parent, 0, 0, 0, 0, 0, 0, compact)
          : this.rows.appendLink(uuid, parent, 0, progress)
        this.register(uuid, row)
      }
      return
    }
    const attachment = asRecord(record.attachment)
    const turn = type === 'user' || type === 'assistant'
    const queuedPrompt =
      type === 'attachment' &&
      attachment?.type === 'queued_command' &&
      attachment.commandMode === 'prompt' &&
      (asRecord(attachment.origin)?.kind ?? 'human') === 'human'
    const decode =
      turn ||
      queuedPrompt ||
      (type === 'system' &&
        subtype === 'local_command' &&
        asRecord(record.commandRun)?.command === 'recap')
    this.hasQueuedPrompts ||= queuedPrompt
    // Skip non-addressable rows that can neither bridge a link nor produce an item.
    if (!uuid && !decode) {
      return
    }
    const message = asRecord(record.message)
    const messageId = type === 'assistant' ? this.ids.intern(message?.id) : 0
    let tool = 0
    let result = false
    if (Array.isArray(message?.content)) {
      for (const item of message.content) {
        const part = asRecord(item)
        const use = messageId !== 0 && part?.type === 'tool_use'
        if (!use && !(type === 'user' && part?.type === 'tool_result')) {
          continue
        }
        result ||= !use
        const id = this.ids.intern(use ? part?.id : part?.tool_use_id)
        if (id) {
          tool = this.links.append(id, tool)
        }
      }
    }
    const flags =
      (decode ? Flag.Decode : 0) |
      (turn ? Flag.Turn : 0) |
      (queuedPrompt ? Flag.QueuedPrompt : 0) |
      (!(type === 'attachment' && attachment?.type === 'fork_briefing') ? Flag.Leaf : 0) |
      (record.isMeta ? Flag.Meta : 0) |
      (result ? Flag.ToolResult : 0) |
      (boundary ? Flag.CompactBoundary : 0) |
      (uuid && type === 'user' && record.isCompactSummary === true ? Flag.CompactSummary : 0)
    const parent = this.parentKey(record, uuid)
    const position =
      decode || boundary ? this.positions.append(range.offset, range.legacyOffset, range.line) : 0
    if (position) {
      this.rangeData.append(range.length, range.digest)
    }
    const row = this.rows.appendRecord(
      uuid,
      parent,
      flags,
      position,
      messageId,
      this.ids.intern(record.agentId),
      this.ids.intern(record.sourceToolAssistantUUID),
      tool,
      compact
    )
    if (uuid) {
      this.register(uuid, row)
    }
  }

  private parentKey(record: Record<string, unknown>, uuid: number): number {
    const previous = this.previousUuid
    const parent =
      previous && record.parentUuid === previous.value
        ? previous.key
        : this.ids.intern(record.parentUuid)
    if (uuid && typeof record.uuid === 'string' && record.uuid.length <= 64) {
      this.previousUuid = { value: record.uuid, key: uuid }
    }
    return parent
  }

  private register(uuid: number, row: number): void {
    if (!this.keys.get(uuid, Key.FirstRow)) {
      this.keys.set(uuid, Key.FirstRow, row)
    }
    this.keys.set(uuid, Key.LatestRow, row)
  }

  private compact(record: Record<string, unknown>): number {
    const metadata = asRecord(record.compactMetadata)
    const messages = asRecord(metadata?.preservedMessages)
    if (messages) {
      const anchor = this.ids.intern(messages.anchorUuid)
      if (!anchor || !Array.isArray(messages.uuids) || !messages.uuids.length) {
        return 0
      }
      // A zero key marks an invalid member, which prevents rewiring the whole list.
      let list = 0
      for (let index = messages.uuids.length - 1; index >= 0; index--) {
        list = this.links.append(this.ids.intern(messages.uuids[index]), list)
      }
      return this.links.append(anchor, list)
    }
    const segment = asRecord(metadata?.preservedSegment)
    const anchor = this.ids.intern(segment?.anchorUuid)
    const head = this.ids.intern(segment?.headUuid)
    const tail = this.ids.intern(segment?.tailUuid)
    return anchor && head && tail ? -this.links.append(anchor, this.links.append(head, tail)) : 0
  }

  async select(check: () => void) {
    const pair = await selectClaudeImportRows(
      this.rows,
      this.keys,
      this.links,
      this.hasQueuedPrompts,
      check
    )
    if (pair) {
      return { boundary: this.range(pair.boundary), summary: this.range(pair.summary) }
    }
    return undefined
  }

  private range(row: number): ClaudeRange {
    const position = this.rows.get(row, Row.Range)
    return {
      offset: this.positions.get(position, Position.Offset),
      legacyOffset: this.positions.get(position, Position.LegacyOffset),
      line: this.positions.get(position, Position.Line),
      length: this.rangeData.get(position, RangeData.Length),
      digest: this.rangeData.get(position, RangeData.Digest)
    }
  }

  *ranges(): Iterable<ClaudeRange> {
    for (let row = this.rows.length; row > 0; row--) {
      const uuid = this.rows.get(row, Row.Uuid)
      if (
        !(this.rows.get(row, Row.Flags) & Flag.Decode) ||
        (uuid && this.keys.get(uuid, Key.LatestRow) !== row)
      ) {
        continue
      }
      const parent = this.rows.get(row, Row.Parent)
      const parentRow = this.keys.get(parent, Key.LatestRow)
      const unanchored = !uuid && (!parent || this.rows.get(parentRow, Row.Flags) & Flag.Selected)
      if (this.rows.get(row, Row.Flags) & Flag.Selected || unanchored) {
        yield this.range(row)
      }
    }
  }
}
