import { describe, expect, it, vi } from 'vitest'
import { MOBILE_SNAPSHOT_BYTE_BUDGET } from '../../../scrollback-limits'
import { terminalStreamJsonByteLength } from '../../../../../shared/terminal-stream-json-byte-length'
import { serializeBudgetedMobileSnapshot } from './terminal-snapshot-publication'
import type { OrcaRuntimeService } from '../../../orca-runtime'

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
function denseRuntime(): OrcaRuntimeService {
  return {
    serializeTerminalBuffer: vi.fn(async (_ptyId: string, options: { scrollbackRows: number }) => ({
      data: colourDenseScreen(Math.max(options.scrollbackRows, 24)),
      cols: COLUMNS,
      rows: 24,
      cwd: '/Users/someone/code/a-repository/packages/a-workspace',
      source: 'headless' as const,
      oscLinks: []
    }))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the serializer under test calls exactly one runtime method, and a full service would be an invented surface.
  } as unknown as OrcaRuntimeService
}

/**
 * A subscriber with a 640 KiB frame cap, which is the page's.
 *
 * Written here rather than imported: this host does not know the bridge and must not, because the
 * budget is a parameter and a client with a different transport has a different one. The page
 * derives its own number from `BRIDGE_MAX_MESSAGE_BYTES` and pins it there; what is checked here
 * is that this side honours whatever it is handed.
 */
const SUBSCRIBER_FRAME_CAP = 640 * 1024
const PAGE_BUDGET = SUBSCRIBER_FRAME_CAP - 88

describe('the mobile snapshot the page receives', () => {
  it('reproduces the defect: the raw budget lets a screen past the frame cap', async () => {
    const serialized = await serializeBudgetedMobileSnapshot(denseRuntime(), 'pty-1', true)
    expect(serialized).not.toBeNull()
    const data = serialized?.data ?? ''
    // Under the budget the desktop applies, which is measured on the text.
    expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(MOBILE_SNAPSHOT_BYTE_BUDGET)
    // And over the cap the bridge applies, which is measured on the frame.
    expect(terminalStreamJsonByteLength(data)).toBeGreaterThan(SUBSCRIBER_FRAME_CAP)
  })

  it('comes back inside the frame cap when the subscriber names its budget', async () => {
    const serialized = await serializeBudgetedMobileSnapshot(
      denseRuntime(),
      'pty-1',
      true,
      PAGE_BUDGET
    )
    expect(serialized).not.toBeNull()
    expect(terminalStreamJsonByteLength(serialized?.data ?? '')).toBeLessThanOrEqual(PAGE_BUDGET)
  })

  it('says it trimmed, so the screen can tell a short scrollback from a whole one', async () => {
    const serialized = await serializeBudgetedMobileSnapshot(
      denseRuntime(),
      'pty-1',
      true,
      PAGE_BUDGET
    )
    expect(serialized?.truncatedByByteBudget).toBe(true)
  })

  it('leaves a subscriber that named no budget on the raw byte rule', async () => {
    // The compatibility half. An older page, and every socket client, sends no field and is served
    // exactly what it was served before: the JSON size is not its transport's problem.
    const runtime = denseRuntime()
    const [withoutBudget, withBudget] = await Promise.all([
      serializeBudgetedMobileSnapshot(runtime, 'pty-1', true),
      serializeBudgetedMobileSnapshot(runtime, 'pty-1', true, PAGE_BUDGET)
    ])
    expect(withoutBudget?.scrollbackRows).toBeGreaterThan(withBudget?.scrollbackRows ?? 0)
  })

  it('counts the metadata the subscriber cannot bound, not only the text', async () => {
    // `cwd`, the OSC-link list and the pending escape tail have no ceiling a client knows, so the
    // page's budget leaves room for them and this side is what spends it. A budget that measured
    // the text alone would hand back a payload that does not fit with a long path in it.
    const runtime = denseRuntime()
    const serialized = await serializeBudgetedMobileSnapshot(runtime, 'pty-1', true, PAGE_BUDGET)
    const textOnly = terminalStreamJsonByteLength(serialized?.data ?? '')
    const withMeta =
      textOnly +
      Buffer.byteLength(
        JSON.stringify({
          cwd: serialized?.cwd,
          oscLinks: serialized?.oscLinks,
          pendingEscapeTailAnsi: serialized?.pendingEscapeTailAnsi,
          source: serialized?.source
        }),
        'utf8'
      )
    expect(withMeta).toBeLessThanOrEqual(PAGE_BUDGET)
  })
})
