// How many rows each task of a per-chat file's copy reads and writes. A user's own copy (a first
// open, or the owed import a read pays) takes whole pages, as it always has. The background copy's
// work takes a page that follows each task's wall time: a whole page where a task is cheap (one
// 512-row commit, as few checkpoints as the copy can have), fewer where a slow disk or CPU makes
// one run long. Measured within one copy, in memory only. The char ceilings still split a page of
// huge rows.

import { setImmediate as yieldToEventLoop } from 'node:timers/promises'

/** A task's wall-time target: past it the next page halves; after two tasks in a row under half
 *  of it (a page's read and its write), it grows a quarter. */
export const IMPORT_TASK_TARGET_MS = 25
/** The fewest rows a page shrinks to. */
export const IMPORT_MIN_PAGE_ROWS = 8

/** The page a copy reads and writes per task, and the yield that ends each task. */
export type JournalImportPaging = {
  readonly rows: number
  yieldTask: () => Promise<void>
}

/** Builds one copy's paging from its most rows and the caller's yield. */
export type JournalImportPages = (
  maxRows: number,
  yieldTask: () => Promise<void>
) => JournalImportPaging

/** Whole pages, the default: a user's own copy. */
export const wholeJournalImportPages: JournalImportPages = (maxRows, yieldTask) => ({
  rows: maxRows,
  yieldTask
})

/** Pages sized by each task's time: the background copy's work. */
export const timedJournalImportPages: JournalImportPages = (maxRows, yieldTask) =>
  new JournalImportPage(maxRows, yieldTask)

export class JournalImportPage implements JournalImportPaging {
  /** Rows the next read takes. */
  rows: number
  private readonly minRows: number
  private taskStart: number
  private fastTasks = 0

  constructor(
    private readonly maxRows: number,
    private readonly yieldToNext: () => Promise<void> = () => yieldToEventLoop(),
    private readonly clock: () => number = () => performance.now()
  ) {
    this.rows = maxRows
    this.minRows = Math.min(IMPORT_MIN_PAGE_ROWS, maxRows)
    this.taskStart = clock()
  }

  /** Ends the task in hand; the next page follows how long it took. */
  yieldTask = async (): Promise<void> => {
    const took = this.clock() - this.taskStart
    this.fastTasks = took < IMPORT_TASK_TARGET_MS / 2 ? this.fastTasks + 1 : 0
    if (took > IMPORT_TASK_TARGET_MS) {
      this.rows = Math.max(this.minRows, Math.floor(this.rows / 2))
    } else if (this.fastTasks === 2) {
      this.fastTasks = 0
      this.rows = Math.min(this.maxRows, Math.ceil(this.rows * 1.25))
    }
    await this.yieldToNext()
    this.taskStart = this.clock()
  }
}
