import { afterEach, describe, expect, it } from 'vitest'
import {
  _resetWorktreeCreateConcurrencyForTests,
  beginPreparationWork,
  beginWorktreeCreate,
  trackPreparationWork
} from './worktree-create-concurrency'

describe('worktree create concurrency', () => {
  afterEach(() => {
    _resetWorktreeCreateConcurrencyForTests()
  })

  it('reports zero for a create that ran alone', () => {
    expect(beginWorktreeCreate().end()).toEqual({ otherCreates: 0, preparations: 0 })
  })

  it('reports the most other creates seen at once, including ones that started later', () => {
    const first = beginWorktreeCreate()
    const second = beginWorktreeCreate()
    const third = beginWorktreeCreate()
    expect(second.end().otherCreates).toBe(2)
    expect(third.end().otherCreates).toBe(2)
    // Peak, not count at the end: `first` once overlapped two others.
    expect(first.end().otherCreates).toBe(2)
  })

  it('stops counting a create once it ends, and a later end returns the same counts', () => {
    const first = beginWorktreeCreate()
    const counts = first.end()
    beginPreparationWork()
    expect(first.end()).toBe(counts)
    expect(beginWorktreeCreate().end().otherCreates).toBe(0)
  })

  it('counts preparation work running at the start and work that starts later, as a peak', () => {
    const running = beginPreparationWork()
    const create = beginWorktreeCreate()
    running.end()
    const later = beginPreparationWork()
    const another = beginPreparationWork()
    later.end()
    another.end()
    expect(create.end().preparations).toBe(2)
  })

  it('leaves out the prepared checkout the create adopted, wherever its peak fell', () => {
    const adopted = beginPreparationWork()
    const create = beginWorktreeCreate()
    const other = beginPreparationWork()
    other.end()
    create.adoptPreparation(adopted)
    adopted.end()
    expect(create.end().preparations).toBe(1)
  })

  it('reports zero when the only work seen was the adopted prepared checkout', () => {
    const create = beginWorktreeCreate()
    const adopted = beginPreparationWork()
    create.adoptPreparation(adopted)
    expect(create.end().preparations).toBe(0)
  })

  it('still counts work that ran after the adopted prepared checkout finished', () => {
    const create = beginWorktreeCreate()
    const adopted = beginPreparationWork()
    create.adoptPreparation(adopted)
    adopted.end()
    beginPreparationWork().end()
    expect(create.end().preparations).toBe(1)
  })

  it('ignores work that starts after the create ended', () => {
    const create = beginWorktreeCreate()
    create.end()
    beginPreparationWork()
    expect(create.end().preparations).toBe(0)
  })

  it('counts tracked work until it settles, including on failure', async () => {
    const observer = beginWorktreeCreate()
    await trackPreparationWork(Promise.reject(new Error('discard failed'))).catch(() => undefined)
    const create = beginWorktreeCreate()
    expect(create.end().preparations).toBe(0)
    expect(observer.end().preparations).toBe(1)
  })
})
