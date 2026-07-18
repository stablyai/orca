import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./runner', () => ({
  gitExecFileAsyncBuffer: vi.fn()
}))

import { gitExecFileAsyncBuffer } from './runner'
import {
  MAX_GIT_SHOW_BYTES,
  readGitBlobRaw,
  resetNativeGitBlobReadStateForTests
} from './blob-reader'

const mockedExec = vi.mocked(gitExecFileAsyncBuffer)

beforeEach(() => resetNativeGitBlobReadStateForTests())
afterEach(() => vi.clearAllMocks())

describe('readGitBlobRaw (CLI path)', () => {
  it('maps a successful git show to found bytes', async () => {
    mockedExec.mockResolvedValue({ stdout: Buffer.from('hello') })
    const raw = await readGitBlobRaw({
      kind: 'rev',
      worktreePath: '/repo',
      rev: 'HEAD',
      gitPath: 'a.txt'
    })
    expect(raw).toEqual({ found: true, tooLarge: false, bytes: Buffer.from('hello') })
    expect(mockedExec).toHaveBeenCalledWith(
      ['show', '--end-of-options', 'HEAD:a.txt'],
      expect.objectContaining({ cwd: '/repo', maxBuffer: MAX_GIT_SHOW_BYTES })
    )
  })

  it('uses the index show form for kind index', async () => {
    mockedExec.mockResolvedValue({ stdout: Buffer.from('x') })
    await readGitBlobRaw({ kind: 'index', worktreePath: '/repo', gitPath: 'b.txt' })
    expect(mockedExec).toHaveBeenCalledWith(
      ['show', ':b.txt'],
      expect.objectContaining({ cwd: '/repo' })
    )
  })

  it('forwards wslDistro runtime options to the exec call', async () => {
    mockedExec.mockResolvedValue({ stdout: Buffer.from('x') })
    await readGitBlobRaw(
      { kind: 'index', worktreePath: '/repo', gitPath: 'b.txt' },
      { wslDistro: 'Ubuntu' }
    )
    expect(mockedExec).toHaveBeenCalledWith(
      ['show', ':b.txt'],
      expect.objectContaining({ cwd: '/repo', wslDistro: 'Ubuntu' })
    )
  })

  it('forwards an abort signal through runtime options to the exec call', async () => {
    mockedExec.mockResolvedValue({ stdout: Buffer.from('x') })
    const signal = new AbortController().signal
    await readGitBlobRaw({ kind: 'index', worktreePath: '/repo', gitPath: 'b.txt' }, { signal })
    expect(mockedExec).toHaveBeenCalledWith(
      ['show', ':b.txt'],
      expect.objectContaining({ cwd: '/repo', signal })
    )
  })

  it('maps maxBuffer overflow to tooLarge', async () => {
    // Node's execFile overflow error: message mentions maxBuffer, which is what
    // isMaxBufferOverflowError matches (alongside code ENOBUFS).
    const error = Object.assign(new Error('stdout maxBuffer length exceeded'), {
      code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
    })
    mockedExec.mockRejectedValue(error)
    const raw = await readGitBlobRaw({
      kind: 'rev',
      worktreePath: '/repo',
      rev: 'HEAD',
      gitPath: 'big.bin'
    })
    expect(raw).toEqual({ found: true, tooLarge: true })
  })

  it('maps an ENOBUFS overflow to tooLarge', async () => {
    const error = Object.assign(new Error('spawn failed'), { code: 'ENOBUFS' })
    mockedExec.mockRejectedValue(error)
    const raw = await readGitBlobRaw({ kind: 'index', worktreePath: '/repo', gitPath: 'big.bin' })
    expect(raw).toEqual({ found: true, tooLarge: true })
  })

  it('maps any other error to not found', async () => {
    mockedExec.mockRejectedValue(new Error('fatal: bad object'))
    const raw = await readGitBlobRaw({
      kind: 'rev',
      worktreePath: '/repo',
      rev: 'deadbeef',
      gitPath: 'a.txt'
    })
    expect(raw).toEqual({ found: false, tooLarge: false })
  })
})
