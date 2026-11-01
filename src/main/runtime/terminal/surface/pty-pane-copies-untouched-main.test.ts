import { describe, expect, it, vi } from 'vitest'
import { HEADLESS_LEAF_ID, TEST_WORKTREE_ID } from '../../orca-runtime-test-fixtures.spec'

import type { RuntimePtyWorktreeRecord } from '../../runtime-terminal-state-records'
import { SURFACE_TAB_ID, surfaceRuntime } from './terminal-surface-replies.test-fixture'

vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

const COPIES = ['tabId', 'paneKey', 'surfaceRecordedAtGraphSequence'] as const

/** Every touch of a record's pane copies, which a layout-owner build must never make (L80). */
function trapPaneCopies(ptysById: Map<string, RuntimePtyWorktreeRecord>): string[] {
  const touched: string[] = []
  const trap = (record: RuntimePtyWorktreeRecord): void => {
    for (const field of COPIES) {
      expect(Object.hasOwn(record, field)).toBe(false)
      Object.defineProperty(record, field, {
        configurable: true,
        get() {
          touched.push(`read ${record.ptyId}.${field}`)
          throw new Error(`pane copy read: ${field}`)
        },
        set() {
          touched.push(`write ${record.ptyId}.${field}`)
          throw new Error(`pane copy write: ${field}`)
        }
      })
    }
  }
  for (const record of ptysById.values()) {
    trap(record)
  }
  // A record made later (a spawn) is trapped as it is stored.
  const set = ptysById.set.bind(ptysById)
  ptysById.set = (ptyId, record) => {
    const stored = set(ptyId, record)
    trap(record)
    return stored
  }
  return touched
}

describe('PTY record pane copies (switch on)', () => {
  it('are not needed with no window: main answers before any graph is installed', async () => {
    const { runtime } = surfaceRuntime()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: ptysById is the runtime's PTY registry; the test traps the records it keeps.
    const { ptysById } = runtime as unknown as { ptysById: Map<string, RuntimePtyWorktreeRecord> }
    const touched = trapPaneCopies(ptysById)
    const published = vi.spyOn(runtime, 'syncWindowGraph')

    expect(runtime['paneOfPty'](ptysById.get('pty-a')!)).toMatchObject({
      tabId: SURFACE_TAB_ID,
      paneKey: `${SURFACE_TAB_ID}:${HEADLESS_LEAF_ID}`
    })
    const listed = await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)
    expect(
      listed.terminals.map(({ tabId, ptyId, orphaned }) => ({ tabId, ptyId, orphaned }))
    ).toEqual([
      { tabId: SURFACE_TAB_ID, ptyId: 'pty-a', orphaned: false },
      { tabId: SURFACE_TAB_ID, ptyId: 'pty-b', orphaned: false }
    ])
    for (const terminal of listed.terminals) {
      await expect(runtime.showTerminal(terminal.handle)).resolves.toMatchObject({
        tabId: SURFACE_TAB_ID
      })
    }
    runtime.registerPty('pty-c', TEST_WORKTREE_ID)
    // Answering is not publishing: no graph is installed until a window or the host sends one.
    expect(published).not.toHaveBeenCalled()
    expect(touched).toEqual([])
  })
})
