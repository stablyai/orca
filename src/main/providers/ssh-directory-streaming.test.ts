import { describe, expect, it, vi } from 'vitest'
import type { SFTPWrapper } from 'ssh2'
import { readDirectoryEntriesViaSftp } from './ssh-filesystem-provider-sftp'
import { readSftpDirectory } from './ssh-sftp-directory-listing'

function fixture(packets: string[][]) {
  let next = 0
  const handle = Buffer.from('directory')
  const sftp = {
    opendir: vi.fn((_path, callback) => callback(null, handle)),
    readdir: vi.fn((_handle, callback) =>
      next < packets.length
        ? callback(
            null,
            packets[next++].map((filename) => ({
              filename,
              attrs: { isSymbolicLink: () => false, isDirectory: () => false }
            }))
          )
        : callback(Object.assign(new Error('EOF'), { code: 1 }))
    ),
    close: vi.fn((_handle, callback) => callback(null))
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fixture implements all three handle operations used by the reader.
  return { mock: sftp, sftp: sftp as unknown as SFTPWrapper }
}

describe('SFTP directory handle ownership', () => {
  it('does not request later packets after a consumer stops', async () => {
    const { sftp, mock } = fixture([['first'], ['second']])
    for await (const entry of readDirectoryEntriesViaSftp(sftp, '/folder')) {
      expect(entry.filename).toBe('first')
      break
    }
    expect(mock.readdir).toHaveBeenCalledTimes(1)
    expect(mock.close).toHaveBeenCalledTimes(1)
  })

  it('continues through empty filtered packets until the protocol EOF error', async () => {
    const { sftp, mock } = fixture([[], ['.', '..'], ['visible']])
    expect((await readSftpDirectory(sftp, '/folder')).map((entry) => entry.name)).toEqual([
      'visible'
    ])
    expect(mock.close).toHaveBeenCalledTimes(1)
  })

  it('rejects capacity before fetching the remaining million-entry directory', async () => {
    const name = 'x'.repeat(1000)
    const { sftp, mock } = fixture(Array.from({ length: 1000 }, () => Array(100).fill(name)))
    await expect(readSftpDirectory(sftp, '/folder')).rejects.toThrow('too large')
    expect(mock.readdir.mock.calls.length).toBeLessThan(50)
    expect(mock.close).toHaveBeenCalledTimes(1)
  })

  it('closes after cancellation between packets', async () => {
    const { sftp, mock } = fixture([['first'], ['second']])
    const controller = new AbortController()
    await expect(
      (async () => {
        for await (const _entry of readDirectoryEntriesViaSftp(sftp, '/folder', {
          signal: controller.signal
        })) {
          controller.abort(new Error('closed'))
        }
      })()
    ).rejects.toThrow('closed')
    expect(mock.close).toHaveBeenCalledTimes(1)
  })
})

it('bounds a silent CLOSE after early stop and ignores its late callback', async () => {
  vi.useFakeTimers()
  try {
    const { sftp, mock } = fixture([['first']])
    let lateClose: (() => void) | undefined
    mock.close.mockImplementation((_handle, callback) => {
      lateClose = () => callback(null)
    })
    const iterator = readDirectoryEntriesViaSftp(sftp, '/folder')
    await iterator.next()
    const stopped = iterator.return(undefined)
    await vi.advanceTimersByTimeAsync(5000)
    await stopped
    expect(mock.close).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    lateClose?.()
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})

it('preserves cancellation when CLOSE never acknowledges', async () => {
  vi.useFakeTimers()
  try {
    const { sftp, mock } = fixture([['first'], ['second']])
    mock.close.mockImplementation(() => {})
    const controller = new AbortController()
    const iterator = readDirectoryEntriesViaSftp(sftp, '/folder', { signal: controller.signal })
    await iterator.next()
    controller.abort(new Error('original cancellation'))
    const rejected = expect(iterator.next()).rejects.toThrow('original cancellation')
    await vi.advanceTimersByTimeAsync(5000)
    await rejected
    expect(mock.close).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})

it('closes a late OPENDIR handle even after cancellation settled', async () => {
  vi.useFakeTimers()
  try {
    const { sftp, mock } = fixture([])
    let lateOpen: (() => void) | undefined
    mock.opendir.mockImplementation((_path, callback) => {
      lateOpen = () => callback(null, Buffer.from('late-handle'))
    })
    mock.close.mockImplementation(() => {})
    const controller = new AbortController()
    const pending = readDirectoryEntriesViaSftp(sftp, '/folder', {
      signal: controller.signal
    }).next()
    const rejected = expect(pending).rejects.toThrow('original cancellation')
    controller.abort(new Error('original cancellation'))
    await vi.advanceTimersByTimeAsync(5000)
    await rejected
    lateOpen?.()
    expect(mock.close).toHaveBeenCalledWith(Buffer.from('late-handle'), expect.any(Function))
    await vi.advanceTimersByTimeAsync(5000)
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})

it('preserves capacity failure when CLOSE never acknowledges', async () => {
  vi.useFakeTimers()
  try {
    const { sftp, mock } = fixture([['x'.repeat(5 * 1024 * 1024)]])
    mock.close.mockImplementation(() => {})
    const rejected = expect(readSftpDirectory(sftp, '/folder')).rejects.toThrow('too large')
    await vi.advanceTimersByTimeAsync(5000)
    await rejected
    expect(mock.close).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})

it('rejects explicit failed CLOSE and retires the persistent channel', async () => {
  const { sftp, mock } = fixture([])
  const end = vi.fn()
  Object.assign(sftp, { end })
  const failure = new Error('CLOSE failed')
  mock.close.mockImplementation((_handle, callback) => callback(failure))
  await expect(readSftpDirectory(sftp, '/folder')).rejects.toBe(failure)
  expect(end).toHaveBeenCalledOnce()
})

it('rejects EOF CLOSE timeout without claiming acknowledgement; late callback stays inert', async () => {
  vi.useFakeTimers()
  try {
    const { sftp, mock } = fixture([])
    const end = vi.fn()
    Object.assign(sftp, { end })
    let lateClose: (() => void) | undefined
    mock.close.mockImplementation((_handle, callback) => {
      lateClose = () => callback(null)
    })
    const rejected = expect(readSftpDirectory(sftp, '/folder')).rejects.toThrow('CLOSE timed out')
    await vi.advanceTimersByTimeAsync(5000)
    await rejected
    expect(end).toHaveBeenCalledOnce()
    lateClose?.()
    expect(end).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})

it.each(['EOF callback', 'CLOSE callback'])(
  'preserves abort reason during final %s',
  async (boundary) => {
    const { sftp, mock } = fixture([])
    const controller = new AbortController()
    const reason = new Error('original final cancellation')
    if (boundary === 'EOF callback') {
      mock.readdir.mockImplementation((_handle, callback) => {
        callback(null, false)
        controller.abort(reason)
      })
    } else {
      mock.close.mockImplementation((_handle, callback) => {
        controller.abort(reason)
        callback(null)
      })
    }
    await expect(readSftpDirectory(sftp, '/folder', { signal: controller.signal })).rejects.toBe(
      reason
    )
  }
)

it('preserves a consumer capacity failure when CLOSE explicitly fails', async () => {
  const { sftp, mock } = fixture([['x'.repeat(5 * 1024 * 1024)]])
  mock.close.mockImplementation((_handle, callback) => callback(new Error('cleanup failed')))
  await expect(readSftpDirectory(sftp, '/folder')).rejects.toThrow('too large')
})

it('keeps the persistent channel for acknowledged normal EOF', async () => {
  const { sftp } = fixture([['visible']])
  const end = vi.fn()
  Object.assign(sftp, { end })
  await expect(readSftpDirectory(sftp, '/folder')).resolves.toHaveLength(1)
  expect(end).not.toHaveBeenCalled()
})

it('cancels a silent symlink STAT and closes its directory handle', async () => {
  vi.useFakeTimers()
  try {
    const { sftp, mock } = fixture([['linked']])
    mock.readdir.mockImplementationOnce((_handle, callback) =>
      callback(null, [
        {
          filename: 'linked',
          attrs: { isSymbolicLink: () => true, isDirectory: () => false }
        }
      ])
    )
    const stat = vi.fn()
    Object.assign(sftp, { stat })
    const controller = new AbortController()
    const reason = new Error('canceled during STAT')
    const pending = readSftpDirectory(sftp, '/folder', { signal: controller.signal })
    await vi.waitFor(() => expect(stat).toHaveBeenCalledOnce())
    const rejected = expect(pending).rejects.toBe(reason)
    controller.abort(reason)
    await vi.advanceTimersByTimeAsync(5000)
    await rejected
    expect(mock.close).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})
