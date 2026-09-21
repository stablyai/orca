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

/**
 * The first frame of a page terminal, which today ends the stream before a byte is painted.
 *
 * The desktop trims the mobile snapshot to 512 KiB of raw terminal text. The page bridge measures
 * the serialized event against 640 KiB, and an ANSI snapshot is mostly ESC bytes, each of which
 * `JSON.stringify` spends six bytes on. A colour-dense 80-column screen crosses 1.43x, so a
 * snapshot the desktop calls budgeted arrives 7% over the cap and `deliver` answers
 * `cancel(id, 'overflow')` — a terminal dead on arrival with no recovery that does not reproduce it.
 */

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

/**
 * A runtime whose scrollback is colour-dense to the row, so trimming rows really trims bytes.
 *
 * Rows rather than a fixed string: the serializer walks [1000, 500, 250, 100, 25, 0] and a stub
 * that answered the same payload every time would prove the loop terminates and nothing else.
 */
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

/**
 * The budget the page really sends, and the stream it is published on.
 *
 * Restated rather than imported: the page is a different program with a different tsconfig, and
 * this host must not know what a bridge is — the budget is a parameter, and a client with another
 * transport has another one. The number is pinned on the page's side in
 * `mobile/src/session/terminal-snapshot-byte-budget.web.test.ts`, so a drift is a red line there
 * rather than a stream that ends on a device.
 */
const PAGE_BUDGET = 655_273
const STREAM_ID = 7

/** What the caller will publish with, which the budget needs because it builds the payload. */
const PUBLICATION = { kind: 'scrollback', displayMode: 'auto' } as const

function budget(bytes: number): MobileSnapshotByteBudget {
  return { bytes, streamId: STREAM_ID, frame: { ...PUBLICATION } }
}

/** Narrowed rather than asserted: a fixture that serialized nothing is a broken case, not a null. */
function required<T>(value: T | null): T {
  if (value === null) {
    throw new Error('the fixture serialized nothing')
  }
  return value
}

/** The payload as the host will publish it, measured the way the host measures it. */
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

/** The `cwd` a real subscription carries, long enough that the metadata is not rounding error. */
const CWD = '/srv/checkouts/a-repository/packages/a-workspace/deeply/nested/leaf'

/**
 * A runtime whose screen is sized so round one's measure lands on exactly the budget.
 *
 * Round one summed the escaped text and four fields. Plain ASCII escapes to its own length plus the
 * two quotes, so the screen below makes that sum exactly `PAGE_BUDGET` — accepted, and at the first
 * candidate, so `truncatedByByteBudget` is false and nothing says it was trimmed. What the host
 * then publishes is that text plus `kind`, `cols`, `rows`, `requestId`, `displayMode`, `reason`,
 * `seq`, both truncation flags, the `type` and `streamId` the client adds, the `serialized` key and
 * the object's own braces. That is the frame the reviewer measured at 655,529 against a
 * 655,360-byte cap.
 */
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
    // Shrinks with the row count, so the trim below has something to trim; at the first candidate
    // it is exactly the screen round one accepted.
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

/**
 * A runtime no candidate can trim under the raw rule, so the zero-row screen is over it too.
 *
 * The same size at every candidate on purpose: what these cases separate is what the loop does
 * when trimming has run out, and a fixture that shrinks would never reach that state.
 */
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
    const serialized = await serializeBudgetedMobileSnapshot(denseRuntime(), 'pty-1', true)
    expect(serialized).not.toBeNull()
    const data = serialized?.data ?? ''
    // Under the budget the desktop applies, which is measured on the text.
    expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(MOBILE_SNAPSHOT_BYTE_BUDGET)
    // And over the cap the bridge applies, which is measured on the whole published payload.
    expect(publishedPayloadBytes(required(serialized))).toBeGreaterThan(PAGE_BUDGET)
  })

  /**
   * The case the first round's measure could not see.
   *
   * It summed the text and four fields, so a snapshot it accepted at exactly the budget published
   * 169 bytes over a 655,360-byte cap and the stream ended with `overflow` before a byte was
   * painted. Measured here against the payload the host really builds, which is the only measure
   * that cannot be wrong by a field.
   */
  it('accepts nothing whose published payload is over the budget', async () => {
    const serialized = await serializeBudgetedMobileSnapshot(
      denseRuntime(),
      'pty-1',
      true,
      budget(PAGE_BUDGET)
    )
    expect(serialized).not.toBeNull()
    expect(publishedPayloadBytes(required(serialized))).toBeLessThanOrEqual(PAGE_BUDGET)
  })

  /**
   * The metadata is counted, not the text alone, and a long `requestId` is part of it.
   *
   * The reviewer's reproduction used an 8-character request id and a 24-character one, 169 and 247
   * bytes over. A budget that ignored the publication fields answers the same for both; one that
   * builds the payload cannot.
   */
  it('trims further when the publication carries more metadata', async () => {
    const runtime = denseRuntime()
    const [plain, withRequestId] = await Promise.all([
      serializeBudgetedMobileSnapshot(runtime, 'pty-1', true, budget(PAGE_BUDGET)),
      serializeBudgetedMobileSnapshot(runtime, 'pty-1', true, {
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
      true,
      budget(PAGE_BUDGET)
    )
    expect(serialized?.truncatedByByteBudget).toBe(true)
  })

  it('leaves a subscriber that named no budget on the raw byte rule', async () => {
    // The compatibility half. An older page, and every socket client, sends no budget and is served
    // exactly what it was served before: the payload size is not its transport's problem.
    const runtime = denseRuntime()
    const [withoutBudget, withBudget] = await Promise.all([
      serializeBudgetedMobileSnapshot(runtime, 'pty-1', true),
      serializeBudgetedMobileSnapshot(runtime, 'pty-1', true, budget(PAGE_BUDGET))
    ])
    expect(withoutBudget?.scrollbackRows).toBeGreaterThan(withBudget?.scrollbackRows ?? 0)
  })

  /**
   * The zero-row candidate a budget still cannot fit, which is where the loop used to give up.
   *
   * Zero scrollback is not a small screen: a wide colour-dense viewport still carries its 24 live
   * rows, and the loop published that candidate whatever it measured. A capped subscriber then got
   * one frame over its cap, ended the stream on `overflow` and painted nothing — the one outcome
   * worse than a blank terminal, because live output would have repainted a blank one in a
   * keystroke and there is no recovery from a stream that never opened.
   *
   * Ruling 15: publish it with the text emptied and the trim flagged. The stream opens, the page
   * knows the screen it holds is not the screen the host had, and the next byte of output fixes it.
   */
  it('empties the text of a zero-row candidate it cannot fit, rather than posting it over', async () => {
    const serialized = await serializeBudgetedMobileSnapshot(
      denseRuntime(),
      'pty-1',
      true,
      budget(4096)
    )
    expect(serialized?.scrollbackRows).toBe(0)
    expect(serialized?.data).toBe('')
    expect(serialized?.truncatedByByteBudget).toBe(true)
    expect(publishedPayloadBytes(required(serialized))).toBeLessThanOrEqual(4096)
  })

  /**
   * The floor, which is the metadata the frame must carry however little the subscriber allows.
   *
   * A budget under it is a subscriber this host cannot serve, and there is nothing further to give
   * up: the text is already gone. Recorded so the behaviour is a decision rather than something
   * read off a stack trace, and so "never an over-budget frame" is read with the one exception it
   * has rather than as a promise the host cannot keep.
   */
  it('cannot go below the metadata the frame carries, and keeps the text empty there', async () => {
    const serialized = await serializeBudgetedMobileSnapshot(
      denseRuntime(),
      'pty-1',
      true,
      budget(16)
    )
    expect(serialized?.scrollbackRows).toBe(0)
    expect(serialized?.data).toBe('')
    expect(serialized?.truncatedByByteBudget).toBe(true)
    expect(publishedPayloadBytes(required(serialized))).toBeGreaterThan(16)
  })

  it('still sends an unbudgeted subscriber the screen it has always been sent', async () => {
    // The other half of ruling 15, and the compatibility one: the raw rule keeps its fallback, so
    // an older page and every socket client get the oversize screen rather than an empty frame.
    const serialized = await serializeBudgetedMobileSnapshot(alwaysOversizeRuntime(), 'pty-1', true)
    expect(serialized?.data.length).toBeGreaterThan(MOBILE_SNAPSHOT_BYTE_BUDGET)
    expect(serialized?.truncatedByByteBudget).toBe(true)
  })
})

describe('a snapshot that round one accepted at exactly the budget', () => {
  /**
   * The blocker, as a number rather than as a claim.
   *
   * This is the frame the host would post. It is over the cap by the fields a summed measure never
   * counted, and every one of them is in the payload the client assembles.
   */
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
      true,
      budget(PAGE_BUDGET)
    )
    expect(serialized).not.toBeNull()
    expect(publishedPayloadBytes(required(serialized))).toBeLessThanOrEqual(PAGE_BUDGET)
    expect(serialized?.truncatedByByteBudget).toBe(true)
  })
})

/**
 * The other loop, which serves the renderer snapshot and retries when output moved under it.
 *
 * Its own case because it is a second copy of the same walk toward zero scrollback, reached by a
 * different caller, and ruling 15 is a property of the walk rather than of either caller. A stable
 * sequence on purpose: what is under test is the last candidate, not the retry.
 */
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

/**
 * The fields the caller decides, which the budget must not read more narrowly than the publication.
 *
 * Every one of these was measured at one value and published at another. `kind` and `reason` drifted
 * because the two objects were written out twice, five lines apart; `displayMode` drifts because
 * the subscribe flow re-reads it from the runtime after the snapshot is serialized and before the
 * frame is sent, so the budget cannot know it at all. Under-measuring any of them is the same
 * defect as the summed field list: the frame goes out larger than the number that approved it.
 */
describe('the publication fields the budget has to assume', () => {
  /** The widest a payload built from these options can be, as the host measures it. */
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

  /** A screen of a fixed size at every candidate, so the budget below is the whole of the margin. */
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
    // `getMobileDisplayMode` answers `'auto' | 'desktop'`, and the subscribe flow re-reads it
    // between serializing the snapshot and sending the frame, so the budget cannot know which it
    // will be. Budgeted at exactly the `'auto'` measure, the `'desktop'` frame is three bytes
    // longer than the number that approved it, and no trimming is left to absorb them: this is the
    // margin, not a fixture with room in it.
    const data = 'x'.repeat(4096)
    const serialized = await serializeBudgetedMobileSnapshot(
      fixedScreenRuntime(data),
      'pty-1',
      true,
      {
        bytes: measured({ kind: 'scrollback', displayMode: 'auto' }, data),
        streamId: STREAM_ID,
        frame: { kind: 'scrollback', displayMode: 'auto' }
      }
    )
    expect(required(serialized).data).toBe('')
  })
})
