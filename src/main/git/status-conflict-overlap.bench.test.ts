
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeFsPromises from 'node:fs/promises'
import type * as GitRunner from './runner'

const { gitStreamStdoutMock, readFileMock } = vi.hoisted(() => ({
  gitStreamStdoutMock: vi.fn(),
  readFileMock: vi.fn()
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>()
  return { ...actual, readFile: readFileMock }
})

vi.mock('./runner', async (importOriginal) => {
  const actual = await importOriginal<typeof GitRunner>()
  return { ...actual, gitStreamStdout: gitStreamStdoutMock }
})

import { getStatus } from './status'
const describeBench = process.env.ORCA_GIT_STATUS_OVERLAP_BENCH === '1' ? describe : describe.skip

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve
  })
  return { promise, resolve }
}

describe('git status conflict-read overlap', () => {

  beforeEach(() => {
    readFileMock.mockReset()
    gitStreamStdoutMock.mockReset()
    readFileMock.mockResolvedValue('gitdir: /repo/.git/worktrees/feature\n')
    gitStreamStdoutMock.mockResolvedValue({ stoppedEarly: false })
  })

  it('starts native status before conflict-marker I/O settles', async () => {
    const markerRead = deferred<string>()
    const statusStarted = deferred<void>()
    readFileMock.mockReturnValue(markerRead.promise)
    gitStreamStdoutMock.mockImplementation(async () => {
      statusStarted.resolve()
      return { stoppedEarly: false }
    })

    const resultPromise = getStatus('/repo')
    await statusStarted.promise
    expect(readFileMock).toHaveBeenCalledWith(join('/repo', '.git'), 'utf-8')

    markerRead.resolve('gitdir: /repo/.git/worktrees/feature\n')
    await expect(resultPromise).resolves.toMatchObject({
      entries: [],
      conflictOperation: 'unknown'
    })
  })

  it('observes an early native status rejection while marker I/O remains pending', async () => {
    const markerRead = deferred<string>()
    readFileMock.mockReturnValue(markerRead.promise)
    gitStreamStdoutMock.mockRejectedValue(new Error('status failed first'))
    let settled = false

    const resultPromise = getStatus('/repo').finally(() => {
      settled = true
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)

    markerRead.resolve('gitdir: /repo/.git/worktrees/feature\n')
    await expect(resultPromise).resolves.toMatchObject({
      entries: [],
      conflictOperation: 'unknown'
    })
  })

  it('keeps a synchronous native status failure fail-soft', async () => {
    const statusError = new Error('status threw')
    gitStreamStdoutMock.mockImplementation(() => {
      throw statusError
    })

    await expect(getStatus('/repo')).resolves.toMatchObject({
      entries: [],
      conflictOperation: 'unknown'
    })
  })

})

describeBench('git status conflict-read overlap benchmark', () => {
})
