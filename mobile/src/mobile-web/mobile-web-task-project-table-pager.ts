import {
  MOBILE_WEB_TASK_PROJECT_PAGE_ROWS,
  MobileWebTaskProjectTablePageResultSchema,
  MobileWebTaskProjectTablePayloadSchema,
  MobileWebTaskProjectTableSchema,
  type MobileWebTaskProjectTable,
  type MobileWebTaskProjectTablePageResult
} from '../../../src/shared/mobile-web/task-project-table-contract'
import { MobileWebBrokerError } from './mobile-web-broker-error'
import { mobileWebEncodedByteLength } from './mobile-web-request-accounting'

const HOST_TABLE_MAX_BYTES = 8 * 1024 * 1024
const PAGE_TARGET_BYTES = 180 * 1024

type Continuation = {
  cursor: string
  table: MobileWebTaskProjectTable
  offset: number
}

export class MobileWebTaskProjectTablePager {
  private continuation: Continuation | null = null
  private active = false
  private nextCursorNumber = 0

  constructor(private readonly randomBytes: (length: number) => Uint8Array) {}

  async page(
    payloadValue: unknown,
    loadTable: (
      payload: Omit<ReturnType<typeof MobileWebTaskProjectTablePayloadSchema.parse>, 'cursor'>
    ) => Promise<unknown>
  ): Promise<MobileWebTaskProjectTablePageResult> {
    if (this.active) {
      throw new MobileWebBrokerError('rate_limited')
    }
    this.active = true
    try {
      const payload = MobileWebTaskProjectTablePayloadSchema.parse(payloadValue)
      const continuation = payload.cursor
        ? this.consume(payload.cursor)
        : await this.begin(payload, loadTable)
      const page = this.createPage(continuation)
      const nextOffset = continuation.offset + page.rows.length
      if (nextOffset < continuation.table.rows.length && page.rows.length === 0) {
        throw new MobileWebBrokerError('too_large')
      }
      const nextCursor =
        nextOffset < continuation.table.rows.length
          ? this.retain(continuation.table, nextOffset)
          : null
      return MobileWebTaskProjectTablePageResultSchema.parse({ ...page, nextCursor })
    } finally {
      this.active = false
    }
  }

  clear(): void {
    this.continuation = null
  }

  private async begin(
    payload: ReturnType<typeof MobileWebTaskProjectTablePayloadSchema.parse>,
    loadTable: (
      value: Omit<ReturnType<typeof MobileWebTaskProjectTablePayloadSchema.parse>, 'cursor'>
    ) => Promise<unknown>
  ): Promise<Continuation> {
    this.clear()
    const { cursor: _cursor, ...request } = payload
    const raw = await loadTable(request)
    if (mobileWebEncodedByteLength(raw) > HOST_TABLE_MAX_BYTES) {
      throw new MobileWebBrokerError('too_large')
    }
    const table = MobileWebTaskProjectTableSchema.parse(raw)
    return { cursor: '', table, offset: 0 }
  }

  private createPage(
    continuation: Continuation
  ): Omit<MobileWebTaskProjectTablePageResult, 'nextCursor'> {
    const first = continuation.offset === 0
    const base = first
      ? {
          project: continuation.table.project,
          selectedView: continuation.table.selectedView,
          totalCount: continuation.table.totalCount,
          parentFieldDropped: continuation.table.parentFieldDropped
        }
      : {}
    const rows = continuation.table.rows.slice(
      continuation.offset,
      continuation.offset + MOBILE_WEB_TASK_PROJECT_PAGE_ROWS
    )
    while (rows.length > 0 && mobileWebEncodedByteLength({ ...base, rows }) > PAGE_TARGET_BYTES) {
      rows.pop()
    }
    if (mobileWebEncodedByteLength({ ...base, rows }) > PAGE_TARGET_BYTES) {
      throw new MobileWebBrokerError('too_large')
    }
    return { ...base, rows }
  }

  private consume(cursor: string): Continuation {
    const continuation = this.continuation
    this.clear()
    if (!continuation || continuation.cursor !== cursor) {
      throw new MobileWebBrokerError('invalid_request')
    }
    return continuation
  }

  private retain(table: MobileWebTaskProjectTable, offset: number): string {
    const cursor = this.createCursor()
    this.continuation = { cursor, table, offset }
    return cursor
  }

  private createCursor(): string {
    const bytes = this.randomBytes(16)
    if (bytes.byteLength !== 16) {
      throw new MobileWebBrokerError('internal')
    }
    const counter = this.nextCursorNumber.toString(36)
    this.nextCursorNumber += 1
    return `task_project_page_${counter}_${Array.from(bytes, byteToHex).join('')}`
  }
}

function byteToHex(value: number): string {
  return value.toString(16).padStart(2, '0')
}
