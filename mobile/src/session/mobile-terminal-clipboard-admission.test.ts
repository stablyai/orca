import { afterEach, expect, it, vi } from 'vitest'
import {
  captureMobileTerminalClipboard,
  MOBILE_TERMINAL_PASTE_RESERVED_BYTES
} from './mobile-terminal-clipboard-snapshot'
import {
  cancelTerminalLivePendingFlush,
  createTerminalLivePendingFlushState,
  queueTerminalLiveMirrorSend
} from '../terminal/terminal-live-pending-flush-state'

const clipboard = vi.hoisted(() => ({ getStringAsync: vi.fn(), getImageAsync: vi.fn() }))
vi.mock('expo-clipboard', () => clipboard)
afterEach(() => {
  vi.resetAllMocks()
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

it('does not read the clipboard when reserved-byte admission is saturated', async () => {
  const state = createTerminalLivePendingFlushState()
  const receipt = deferred<boolean>()
  const requests: Promise<boolean>[] = []
  const snapshots: ReturnType<typeof captureMobileTerminalClipboard>[] = []
  clipboard.getStringAsync.mockResolvedValue('retained')
  for (let index = 0; index < 4; index++) {
    requests.push(
      queueTerminalLiveMirrorSend(state, 't', '', () => receipt.promise, {
        barrier: true,
        reservedBytes: MOBILE_TERMINAL_PASTE_RESERVED_BYTES,
        onAdmitted: () => {
          snapshots.push(captureMobileTerminalClipboard(vi.fn()))
        }
      })
    )
  }
  expect(state.retainedBytes).toBe(1024 * 1024)
  expect(clipboard.getStringAsync).toHaveBeenCalledTimes(4)
  expect(
    await queueTerminalLiveMirrorSend(state, 't', '', async () => true, {
      reservedBytes: MOBILE_TERMINAL_PASTE_RESERVED_BYTES,
      onAdmitted: () => {
        snapshots.push(captureMobileTerminalClipboard(vi.fn()))
      }
    })
  ).toBe(false)
  expect(clipboard.getStringAsync).toHaveBeenCalledTimes(4)
  expect(state.retainedBytes).toBe(MOBILE_TERMINAL_PASTE_RESERVED_BYTES)
  receipt.resolve(true)
  expect(await Promise.all(requests)).toEqual([true, false, false, false])
  expect(state.retainedBytes).toBe(0)
  snapshots.forEach((snapshot) => snapshot.dispose())
})

it('retains an early snapshot rejection until dispatch and fences the suffix', async () => {
  const state = createTerminalLivePendingFlushState()
  const earlier = deferred<boolean>()
  const read = deferred<string>()
  clipboard.getStringAsync.mockReturnValue(read.promise)
  const first = queueTerminalLiveMirrorSend(state, 't', '', () => earlier.promise, {
    barrier: true
  })
  let snapshot!: ReturnType<typeof captureMobileTerminalClipboard>
  const paste = queueTerminalLiveMirrorSend(
    state,
    't',
    '',
    async () => {
      await snapshot.read()
      return true
    },
    {
      barrier: true,
      onAdmitted: () => {
        snapshot = captureMobileTerminalClipboard(vi.fn())
      }
    }
  )
  const suffix = vi.fn(async () => true)
  const control = queueTerminalLiveMirrorSend(state, 't', '\r', suffix, { barrier: true })
  read.reject(new Error('clipboard denied before dispatch'))
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  expect(suffix).not.toHaveBeenCalled()
  earlier.resolve(true)
  expect(await Promise.all([first, paste, control])).toEqual([true, false, false])
  expect(suffix).not.toHaveBeenCalled()
  snapshot.dispose()
  expect(await snapshot.read()).toBeUndefined()
})

it('releases reservation and discards a late clipboard result on queue cancellation', async () => {
  const state = createTerminalLivePendingFlushState()
  const earlier = deferred<boolean>()
  const read = deferred<string>()
  clipboard.getStringAsync.mockReturnValue(read.promise)
  const first = queueTerminalLiveMirrorSend(state, 't', '', () => earlier.promise)
  let snapshot!: ReturnType<typeof captureMobileTerminalClipboard>
  const sender = vi.fn(async () => {
    await snapshot.read()
    return true
  })
  const pasted = queueTerminalLiveMirrorSend(state, 't', '', sender, {
    barrier: true,
    reservedBytes: MOBILE_TERMINAL_PASTE_RESERVED_BYTES,
    onAdmitted: () => {
      snapshot = captureMobileTerminalClipboard(vi.fn())
    }
  }).finally(() => snapshot.dispose())
  cancelTerminalLivePendingFlush(state)
  expect(await pasted).toBe(false)
  expect(state.retainedBytes).toBe(0)
  expect(state.requestCount).toBe(0)
  read.resolve('late private clipboard')
  expect(await snapshot.read()).toBeUndefined()
  expect(sender).not.toHaveBeenCalled()
  earlier.resolve(true)
  expect(await first).toBe(false)
  expect(await queueTerminalLiveMirrorSend(state, 't', 'fresh', async () => true)).toBe(true)
})

it('fails admission callback exceptions without dispatch or leaked reservations', async () => {
  const state = createTerminalLivePendingFlushState()
  const sender = vi.fn(async () => true)
  expect(
    await queueTerminalLiveMirrorSend(state, 't', '', sender, {
      reservedBytes: MOBILE_TERMINAL_PASTE_RESERVED_BYTES,
      onAdmitted: () => {
        throw new Error('snapshot initialization failed')
      }
    })
  ).toBe(false)
  expect(sender).not.toHaveBeenCalled()
  expect(state.retainedBytes).toBe(0)
  expect(state.requestCount).toBe(0)
  expect(state.current).toBeNull()
  expect(state.failed).toBe(true)
})

it('does not start image reading after a disposed text read finishes empty', async () => {
  const read = deferred<string>()
  clipboard.getStringAsync.mockReturnValue(read.promise)
  const snapshot = captureMobileTerminalClipboard(vi.fn())
  snapshot.dispose()
  read.resolve('')
  expect(await snapshot.read()).toBeUndefined()
  expect(clipboard.getImageAsync).not.toHaveBeenCalled()
})

it('downscales oversized images before retaining the snapshot', async () => {
  clipboard.getStringAsync.mockResolvedValue('')
  clipboard.getImageAsync.mockResolvedValue({
    data: 'A'.repeat(25 * 1024 * 1024),
    size: { width: 4000, height: 4000 }
  })
  const resize = vi.fn(async () => ({ data: 'AAAA', width: 100, height: 100 }))
  const snapshot = captureMobileTerminalClipboard(resize)
  try {
    expect((await snapshot.read())?.image?.data).toBe('AAAA')
    expect(resize).toHaveBeenCalledTimes(1)
  } finally {
    snapshot.dispose()
  }
})

it('bounds retained image snapshots separately from queue text reservations', async () => {
  clipboard.getStringAsync.mockResolvedValue('')
  clipboard.getImageAsync.mockResolvedValue({
    data: 'A'.repeat(24 * 1024 * 1024),
    size: { width: 4000, height: 4000 }
  })
  const first = captureMobileTerminalClipboard(vi.fn())
  await first.read()
  const second = captureMobileTerminalClipboard(vi.fn())
  try {
    await expect(second.read()).rejects.toThrow('Too much clipboard image data pending')
    first.dispose()
    first.dispose()
    const third = captureMobileTerminalClipboard(vi.fn())
    try {
      expect((await third.read())?.image).not.toBeNull()
    } finally {
      third.dispose()
    }
  } finally {
    first.dispose()
    second.dispose()
  }
})

it('keeps image preparation permits until cancelled native reads actually settle', async () => {
  clipboard.getStringAsync.mockResolvedValue('')
  const image = deferred<null>()
  clipboard.getImageAsync.mockReturnValue(image.promise)
  const snapshots = Array.from({ length: 4 }, () => captureMobileTerminalClipboard(vi.fn()))
  await Promise.resolve()
  expect(clipboard.getImageAsync).toHaveBeenCalledTimes(4)
  snapshots.forEach((snapshot) => snapshot.dispose())
  const refused = captureMobileTerminalClipboard(vi.fn())
  try {
    await expect(refused.read()).rejects.toThrow('Too many clipboard image preparations pending')
    expect(clipboard.getImageAsync).toHaveBeenCalledTimes(4)
  } finally {
    refused.dispose()
    image.resolve(null)
    await Promise.all(snapshots.map((snapshot) => snapshot.read()))
  }
  const fresh = captureMobileTerminalClipboard(vi.fn())
  try {
    expect(await fresh.read()).toEqual({ text: '', image: null })
  } finally {
    fresh.dispose()
  }
})
