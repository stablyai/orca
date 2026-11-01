import { describe, expect, it, vi } from 'vitest'
import { MOBILE_SNAPSHOT_BYTE_BUDGET } from '../../../scrollback-limits'
import { terminalSnapshotPayloadJsonBytes } from './terminal-snapshot-payload'
import {
  serializeBudgetedMobileSnapshot,
  serializeStableMobileRendererSnapshot,
  type MobileSnapshotByteBudget
} from './terminal-snapshot-publication'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import type { SerializedSnapshot } from './terminal-stream-types'

/** Raw 512-KiB text can exceed the page's 640-KiB JSON frame cap: escaped ANSI bytes expand and overflow closes the stream before painting. */

const COLUMNS = 80

/** One SGR colour change per cell, which is the worst case a real screen reaches. */
function colourDenseRow(row: number): string {
  let line = ''
  for (let column = 0; column < COLUMNS; column += 1) {
    line += `\u001b[38;5;${(row * COLUMNS + column) % 256}m#`
  }
  return `${line}\u001b[0m\r\n`
}

function colourDenseScreen(rows: number): string {
  let screen = ''
  for (let row = 0; row < rows; row += 1) {
    screen += colourDenseRow(row)
  }
  return screen
}

/** Shrink with row count so the test proves trimming works, not merely that the loop terminates. */
function denseRuntime(): Pick<OrcaRuntimeService, 'serializeTerminalBuffer'> {
  return {
    serializeTerminalBuffer: vi.fn(
      async (_ptyId: string, options?: { scrollbackRows?: number }) => ({
        data: colourDenseScreen(Math.max(options?.scrollbackRows ?? 0, 24)),
        cols: COLUMNS,
        rows: 24,
        // A long path, because it is one of the fields the subscriber cannot bound from its own side.
        cwd: '/srv/checkouts/a-repository/packages/a-workspace/deeply/nested/leaf',
        source: 'headless' as const,
        oscLinks: []
      })
    )
  }
}

/** Keep the host transport-independent; mobile/src/session/terminal-snapshot-byte-budget.web.test.ts pins the page's matching budget. */
const PAGE_BUDGET = 655_273
const STREAM_ID = 7

const PUBLICATION = { kind: 'scrollback', displayMode: 'auto' } as const

function budget(bytes: number): MobileSnapshotByteBudget {
  return { bytes, streamId: STREAM_ID, frame: { ...PUBLICATION } }
}

function required<T>(value: T | null): T {
  if (value === null) {
    throw new Error('the fixture serialized nothing')
  }
  return value
}

function publishedPayloadBytes(serialized: NonNullable<SerializedSnapshot>): number {
  return terminalSnapshotPayloadJsonBytes(
    {
      ...PUBLICATION,
      cols: serialized.cols,
      rows: serialized.rows,
      seq: serialized.seq,
      cwd: serialized.cwd,
      source: serialized.source,
      oscLinks: serialized.oscLinks,
      truncated: false,
      truncatedByByteBudget: serialized.truncatedByByteBudget,
      data: serialized.data
    },
    STREAM_ID
  )
}

const CWD = '/srv/checkouts/a-repository/packages/a-workspace/deeply/nested/leaf'

/** Fit the old text-plus-four-fields measure exactly; omitted publication metadata then pushes the real frame over budget. */
function exactlyAtRoundOnesBudgetRuntime(): Pick<OrcaRuntimeService, 'serializeTerminalBuffer'> {
  const metaBytes = Buffer.byteLength(
    JSON.stringify({
      cwd: CWD,
      oscLinks: [],
      pendingEscapeTailAnsi: undefined,
      source: 'headless'
    }),
    'utf8'
  )
  const fullLength = PAGE_BUDGET - 2 - metaBytes
  return {
    // Start exactly at the old measure's budget, then shrink so trimming can succeed.
    serializeTerminalBuffer: vi.fn(
      async (_ptyId: string, options?: { scrollbackRows?: number }) => ({
        data: 'x'.repeat(
          Math.floor((fullLength * Math.min(options?.scrollbackRows ?? 0, 1000)) / 1000)
        ),
        cols: COLUMNS,
        rows: 24,
        seq: 4_294_967_295,
        cwd: CWD,
        source: 'headless' as const,
        oscLinks: []
      })
    )
  }
}

/** Keep every candidate oversized to exercise the exhausted trimming ladder. */
function alwaysOversizeRuntime(): Pick<OrcaRuntimeService, 'serializeTerminalBuffer'> {
  return {
    serializeTerminalBuffer: vi.fn(async () => ({
      data: 'x'.repeat(MOBILE_SNAPSHOT_BYTE_BUDGET + 1024),
      cols: COLUMNS,
      rows: 24,
      cwd: CWD,
      source: 'headless' as const,
      oscLinks: []
    }))
  }
}

describe('the mobile snapshot the page receives', () => {
  it('reproduces the defect: the raw budget lets a screen past the frame cap', async () => {
    const serialized = await serializeBudgetedMobileSnapshot(denseRuntime(), 'pty-1')
    expect(serialized).not.toBeNull()
    const data = serialized?.data ?? ''
    expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(MOBILE_SNAPSHOT_BYTE_BUDGET)
    expect(publishedPayloadBytes(required(serialized))).toBeGreaterThan(PAGE_BUDGET)
  })

  it('accepts nothing whose published payload is over the budget', async () => {
    const serialized = await serializeBudgetedMobileSnapshot(
      denseRuntime(),
      'pty-1',
      budget(PAGE_BUDGET)
    )
    expect(serialized).not.toBeNull()
    expect(publishedPayloadBytes(required(serialized))).toBeLessThanOrEqual(PAGE_BUDGET)
  })

  it('trims further when the publication carries more metadata', async () => {
    const runtime = denseRuntime()
    const [plain, withRequestId] = await Promise.all([
      serializeBudgetedMobileSnapshot(runtime, 'pty-1', budget(PAGE_BUDGET)),
      serializeBudgetedMobileSnapshot(runtime, 'pty-1', {
        bytes: PAGE_BUDGET,
        streamId: STREAM_ID,
        frame: { ...PUBLICATION, reason: 'a-reason-of-some-length', requestId: 999_999_999 }
      })
    ])
    expect(publishedPayloadBytes(required(plain))).toBeLessThanOrEqual(PAGE_BUDGET)
    expect(publishedPayloadBytes(required(withRequestId))).toBeLessThanOrEqual(PAGE_BUDGET)
  })

  it('says it trimmed, so the screen can tell a short scrollback from a whole one', async () => {
    const serialized = await serializeBudgetedMobileSnapshot(
      denseRuntime(),
      'pty-1',
      budget(PAGE_BUDGET)
    )
    expect(serialized?.truncatedByByteBudget).toBe(true)
  })

  it('leaves a subscriber that named no budget on the raw byte rule', async () => {
    const runtime = denseRuntime()
    const [withoutBudget, withBudget] = await Promise.all([
      serializeBudgetedMobileSnapshot(runtime, 'pty-1'),
      serializeBudgetedMobileSnapshot(runtime, 'pty-1', budget(PAGE_BUDGET))
    ])
    expect(withoutBudget?.scrollbackRows).toBeGreaterThan(withBudget?.scrollbackRows ?? 0)
  })

  /** Zero scrollback still includes the screen; empty oversized text so the stream opens and later output can repaint it. */
  it('empties the text of a zero-row candidate it cannot fit, rather than posting it over', async () => {
    const serialized = await serializeBudgetedMobileSnapshot(denseRuntime(), 'pty-1', budget(4096))
    expect(serialized?.scrollbackRows).toBe(0)
    expect(serialized?.data).toBe('')
    expect(serialized?.truncatedByByteBudget).toBe(true)
    expect(publishedPayloadBytes(required(serialized))).toBeLessThanOrEqual(4096)
  })

  /** Metadata alone may exceed the cap; empty text is the smallest frame the host can send. */
  it('cannot go below the metadata the frame carries, and keeps the text empty there', async () => {
    const serialized = await serializeBudgetedMobileSnapshot(denseRuntime(), 'pty-1', budget(16))
    expect(serialized?.scrollbackRows).toBe(0)
    expect(serialized?.data).toBe('')
    expect(serialized?.truncatedByByteBudget).toBe(true)
    expect(publishedPayloadBytes(required(serialized))).toBeGreaterThan(16)
  })

  it('still sends an unbudgeted subscriber the screen it has always been sent', async () => {
    const serialized = await serializeBudgetedMobileSnapshot(alwaysOversizeRuntime(), 'pty-1')
    expect(serialized?.data.length).toBeGreaterThan(MOBILE_SNAPSHOT_BYTE_BUDGET)
    expect(serialized?.truncatedByByteBudget).toBe(true)
  })
})

describe('a snapshot that round one accepted at exactly the budget', () => {
  it('publishes a payload over the budget when nothing trims it', async () => {
    const runtime = exactlyAtRoundOnesBudgetRuntime()
    const untrimmed = required(
      await runtime.serializeTerminalBuffer('pty-1', { scrollbackRows: 1000 })
    )
    const published = terminalSnapshotPayloadJsonBytes(
      {
        ...PUBLICATION,
        cols: untrimmed.cols,
        rows: untrimmed.rows,
        seq: untrimmed.seq,
        cwd: untrimmed.cwd,
        source: untrimmed.source,
        oscLinks: untrimmed.oscLinks,
        truncated: false,
        truncatedByByteBudget: false,
        data: untrimmed.data
      },
      STREAM_ID
    )
    expect(published).toBeGreaterThan(PAGE_BUDGET)
  })

  it('is trimmed by the measure that builds the payload, and says so', async () => {
    const serialized = await serializeBudgetedMobileSnapshot(
      exactlyAtRoundOnesBudgetRuntime(),
      'pty-1',
      budget(PAGE_BUDGET)
    )
    expect(serialized).not.toBeNull()
    expect(publishedPayloadBytes(required(serialized))).toBeLessThanOrEqual(PAGE_BUDGET)
    expect(serialized?.truncatedByByteBudget).toBe(true)
  })
})

/** Keep renderer output sequence stable to test its trimming floor rather than its retry path. */
function stableRendererRuntime(): Pick<
  OrcaRuntimeService,
  'getPtyOutputSequence' | 'serializeRendererTerminalBuffer'
> {
  return {
    getPtyOutputSequence: vi.fn(() => 11),
    serializeRendererTerminalBuffer: vi.fn(
      async (_ptyId: string, options?: { scrollbackRows?: number }) => ({
        data: colourDenseScreen(Math.max(options?.scrollbackRows ?? 0, 24)),
        cols: COLUMNS,
        rows: 24,
        cwd: CWD,
        source: 'renderer' as const,
        oscLinks: []
      })
    )
  }
}

describe('the renderer snapshot the page receives', () => {
  it('empties the text of a zero-row candidate it cannot fit', async () => {
    const serialized = await serializeStableMobileRendererSnapshot(
      stableRendererRuntime(),
      'pty-1',
      budget(4096)
    )
    expect(serialized?.scrollbackRows).toBe(0)
    expect(serialized?.data).toBe('')
    expect(serialized?.truncatedByByteBudget).toBe(true)
    expect(publishedPayloadBytes(required(serialized))).toBeLessThanOrEqual(4096)
  })

  it('leaves an unbudgeted subscriber its screen', async () => {
    const serialized = await serializeStableMobileRendererSnapshot(stableRendererRuntime(), 'pty-1')
    expect(serialized?.data.length).toBeGreaterThan(0)
  })
})

/** Budget and publication must share kind/reason; displayMode can change after serialization and needs its widest value. */
describe('the publication fields the budget has to assume', () => {
  function measured(frame: MobileSnapshotByteBudget['frame'], data: string): number {
    return terminalSnapshotPayloadJsonBytes(
      {
        ...frame,
        requestId: Number.MAX_SAFE_INTEGER,
        seq: Number.MAX_SAFE_INTEGER,
        truncated: false,
        truncatedByByteBudget: false,
        cols: COLUMNS,
        rows: 24,
        cwd: CWD,
        source: 'headless',
        oscLinks: [],
        data
      },
      STREAM_ID
    )
  }

  /** A fixed-size screen leaves no trimming margin for undercounted metadata. */
  function fixedScreenRuntime(data: string): Pick<OrcaRuntimeService, 'serializeTerminalBuffer'> {
    return {
      serializeTerminalBuffer: vi.fn(async () => ({
        data,
        cols: COLUMNS,
        rows: 24,
        cwd: CWD,
        source: 'headless' as const,
        oscLinks: []
      }))
    }
  }

  it('covers a publication that carries the wider display mode', async () => {
    // Mode is re-read before publication: desktop needs three more bytes than auto, with no fixture margin to absorb them.
    const data = 'x'.repeat(4096)
    const serialized = await serializeBudgetedMobileSnapshot(fixedScreenRuntime(data), 'pty-1', {
      bytes: measured({ kind: 'scrollback', displayMode: 'auto' }, data),
      streamId: STREAM_ID,
      frame: { kind: 'scrollback', displayMode: 'auto' }
    })
    expect(required(serialized).data).toBe('')
  })
})
