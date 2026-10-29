import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { MOBILE_SNAPSHOT_BYTE_BUDGET } from '../../../scrollback-limits'
import { buildSnapshotFrameMeta } from './terminal-snapshot-payload'
import { serializeBudgetedMobileSnapshot } from './terminal-snapshot-publication'
import { isMovedPaneHistorySessionId } from '../../../../../shared/orcad-migration/orcad-migration-terminal-history'

function historyRuntime(bytesPerRow: number): Pick<OrcaRuntimeService, 'serializeTerminalBuffer'> {
  return {
    serializeTerminalBuffer: vi.fn(
      async (_ptyId: string, options?: { scrollbackRows?: number }) => ({
        scrollbackAnsi: 'h'.repeat((options?.scrollbackRows ?? 0) * bytesPerRow),
        data: 'SCREEN',
        cols: 80,
        rows: 24
      })
    )
  }
}

describe('subscribe snapshot scrollback (#20158)', () => {
  it('serializes history for every subscriber, not a screen-only image', async () => {
    const runtime = historyRuntime(10)
    const serialized = await serializeBudgetedMobileSnapshot(runtime, 'pty-1')
    expect(runtime.serializeTerminalBuffer).toHaveBeenCalledTimes(1)
    expect(runtime.serializeTerminalBuffer).toHaveBeenCalledWith('pty-1', { scrollbackRows: 1000 })
    expect(serialized?.scrollbackRows).toBe(1000)
    expect(serialized?.data).toBe(`${'h'.repeat(10_000)}SCREEN`)
  })

  it('steps down the row ladder when history is over the byte budget', async () => {
    // 1000 rows is over 512 KiB, 500 rows is not.
    const bytesPerRow = Math.floor(MOBILE_SNAPSHOT_BYTE_BUDGET / 600)
    const serialized = await serializeBudgetedMobileSnapshot(historyRuntime(bytesPerRow), 'pty-1')
    expect(serialized?.scrollbackRows).toBe(500)
    expect(serialized?.data.endsWith('SCREEN')).toBe(true)
  })
})

describe('subscribe snapshot of a WSL-moved pane', () => {
  it('tries the larger first row count, then the usual ladder within the same byte budget', async () => {
    const small = historyRuntime(10)
    expect(
      (await serializeBudgetedMobileSnapshot(small, 'pty-1', undefined, 5000))?.scrollbackRows
    ).toBe(5000)
    // 5000 and 2000 rows are over 512 KiB, 1000 is not.
    const wide = historyRuntime(Math.floor(MOBILE_SNAPSHOT_BYTE_BUDGET / 1500))
    expect(
      (await serializeBudgetedMobileSnapshot(wide, 'pty-1', undefined, 5000))?.scrollbackRows
    ).toBe(1000)
  })

  it('names only moved panes by their session id', () => {
    expect(isMovedPaneHistorySessionId('repo::/w@@moved-0123456789abcdef')).toBe(true)
    expect(isMovedPaneHistorySessionId('repo::/w@@a1b2c3d4')).toBe(false)
    expect(isMovedPaneHistorySessionId('moved-0123456789abcdef')).toBe(false)
  })
})

describe('SnapshotStart scrollbackRows', () => {
  const base = { kind: 'scrollback' as const, cols: 80, rows: 24, data: '' }

  it('publishes how many history rows the image carries, including zero', () => {
    expect(buildSnapshotFrameMeta({ ...base, scrollbackRows: 1000 }).scrollbackRows).toBe(1000)
    expect(buildSnapshotFrameMeta({ ...base, scrollbackRows: 0 }).scrollbackRows).toBe(0)
  })

  it('omits the field when the publisher does not know, so the client reads it as unknown', () => {
    expect('scrollbackRows' in buildSnapshotFrameMeta(base)).toBe(false)
  })
})
