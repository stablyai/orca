// The page a per-chat file's copy reads and writes per task follows how long its last task took.

import { describe, expect, it } from 'vitest'
import {
  IMPORT_MIN_PAGE_ROWS,
  IMPORT_TASK_TARGET_MS,
  JournalImportPage
} from './journal-import-page'

/** A page on a clock the test moves; each task "takes" the time given. */
function pageOn(maxRows: number) {
  let now = 0
  const page = new JournalImportPage(
    maxRows,
    async () => undefined,
    () => now
  )
  return {
    page,
    task: async (ms: number) => {
      now += ms
      await page.yieldTask()
    }
  }
}

describe('the import page', () => {
  it('halves the next page after a task over the target', async () => {
    const { page, task } = pageOn(512)
    await task(IMPORT_TASK_TARGET_MS + 1)
    expect(page.rows).toBe(256)
    await task(400)
    expect(page.rows).toBe(128)
  })

  it('keeps the page for a task between half the target and the target', async () => {
    const { page, task } = pageOn(512)
    await task(400)
    await task(IMPORT_TASK_TARGET_MS)
    await task(IMPORT_TASK_TARGET_MS / 2)
    expect(page.rows).toBe(256)
  })

  it('grows back a quarter per two fast tasks in a row, never past its most rows', async () => {
    const { page, task } = pageOn(512)
    for (let slow = 0; slow < 20; slow += 1) {
      await task(400)
    }
    expect(page.rows).toBe(IMPORT_MIN_PAGE_ROWS)
    const sizes: number[] = []
    for (let fast = 0; fast < 60; fast += 1) {
      await task(1)
      sizes.push(page.rows)
    }
    expect(sizes.slice(0, 6)).toEqual([8, 10, 10, 13, 13, 17])
    expect(Math.max(...sizes)).toBe(512)
    expect(sizes.at(-1)).toBe(512)
  })

  it('does not grow on a fast task that follows a slow one', async () => {
    const { page, task } = pageOn(512)
    // A slow write, then a fast read, in turn: the page only shrinks.
    for (let pageCount = 0; pageCount < 3; pageCount += 1) {
      await task(400)
      await task(1)
    }
    expect(page.rows).toBe(64)
  })

  it('never shrinks below its fewest rows, nor below a smaller most', async () => {
    const small = pageOn(4)
    await small.task(400)
    expect(small.page.rows).toBe(4)
    const { page, task } = pageOn(512)
    for (let slow = 0; slow < 20; slow += 1) {
      await task(10_000)
    }
    expect(page.rows).toBe(IMPORT_MIN_PAGE_ROWS)
  })

  it('stays a whole page while every task is fast', async () => {
    const { page, task } = pageOn(512)
    for (let fast = 0; fast < 10; fast += 1) {
      await task(1)
    }
    expect(page.rows).toBe(512)
  })
})
