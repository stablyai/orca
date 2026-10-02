import { describe, expect, it } from 'vitest'
import type { WorktreeCheckoutProgress } from '../../shared/worktree/create-types'
import { createWorktreeCheckoutProgressReader } from './worktree-checkout-progress'

function record(completed: number, total: number, done = false): string {
  const percent = Math.floor((completed * 100) / total)
  return `Updating files: ${String(percent).padStart(3)}% (${completed}/${total})${done ? ', done.\n' : '\r'}`
}

function harness(): {
  reports: (WorktreeCheckoutProgress | null)[]
  reader: ReturnType<typeof createWorktreeCheckoutProgressReader>
} {
  const reports: (WorktreeCheckoutProgress | null)[] = []
  const reader = createWorktreeCheckoutProgressReader((progress) => reports.push(progress))
  return { reports, reader }
}

describe('createWorktreeCheckoutProgressReader', () => {
  it('reports every percent git prints, then the end of the checkout', () => {
    const { reports, reader } = harness()
    reader.read(record(1, 100))
    reader.read(record(2, 100) + record(3, 100))
    reader.read(record(100, 100))
    reader.read(record(100, 100, true))

    expect(reports).toEqual([
      { percent: 1, completed: 1, total: 100 },
      { percent: 2, completed: 2, total: 100 },
      { percent: 3, completed: 3, total: 100 },
      { percent: 100, completed: 100, total: 100 },
      null
    ])
  })

  it('delivers the record git prints after a stall, so the bar never lags git', () => {
    const { reports, reader } = harness()
    reader.read(record(40, 100))
    // After each one-second tick git reprints the same percent once, on its next file.
    reader.read(record(40, 100))
    reader.read(record(40, 100))
    reader.read(record(60, 100))

    expect(reports).toEqual([
      { percent: 40, completed: 40, total: 100 },
      { percent: 60, completed: 60, total: 100 }
    ])
  })

  it('never moves backwards, so a hook re-running a checkout from 0% is ignored', () => {
    const { reports, reader } = harness()
    reader.read(record(40, 100))
    reader.read(record(0, 100))
    reader.read(record(39, 100))
    reader.read(record(40, 100))
    reader.read(record(41, 100))

    expect(reports.map((progress) => progress?.percent)).toEqual([40, 41])
  })

  it('reports the end of the checkout once and nothing after it', () => {
    const { reports, reader } = harness()
    reader.read(record(10, 10))
    reader.read(record(10, 10, true))
    // A post-checkout hook running its own checkout writes to the same pipe.
    reader.read(record(5, 10))
    reader.read(record(10, 10))
    reader.read(record(10, 10, true))

    expect(reports).toEqual([{ percent: 100, completed: 10, total: 10 }, null])
  })

  it('reports nothing once closed, which the create does when git exits or fails', () => {
    const { reports, reader } = harness()
    reader.read(record(3, 10))
    reader.close()
    reader.read(record(9, 10))
    reader.read(record(10, 10, true))

    expect(reports).toEqual([{ percent: 30, completed: 3, total: 10 }])
  })

  it('ignores stderr that carries no checkout meter', () => {
    const { reports, reader } = harness()
    reader.read("Preparing worktree (new branch 'feature')\n")
    reader.read('fatal: could not create work tree dir\n')

    expect(reports).toEqual([])
  })
})
