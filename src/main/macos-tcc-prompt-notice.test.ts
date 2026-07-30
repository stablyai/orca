import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeFs from 'node:fs'

const writeFileAtomically = vi.fn()
const readTallyFile = vi.fn()
const watchStart = vi.fn()
const watchStop = vi.fn()
const watchOptions: { onPrompt: () => void }[] = []
vi.mock('./codex-accounts/fs-utils', () => ({
  writeFileAtomically: (...args: unknown[]) => writeFileAtomically(...args)
}))
vi.mock('./persistence', () => ({ getCanonicalUserDataPath: () => '/tmp/orca-tcc-notice-test' }))
vi.mock('./macos-tcc-prompt-watch', () => ({
  MacosTccPromptWatch: class {
    constructor(options: { onPrompt: () => void }) {
      watchOptions.push(options)
    }
    start(): void {
      watchStart()
    }
    stop(): void {
      watchStop()
    }
  }
}))
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeFs>()),
  readFileSync: (...args: unknown[]) => readTallyFile(...args)
}))

const {
  TCC_PROMPT_NOTICE_THRESHOLD,
  TCC_PROMPT_WATCH_START_FALLBACK_MS,
  acknowledgePendingTccPromptNotice,
  consumePendingTccPromptNotice,
  dismissTccPromptNotice,
  handleTccPromptForTests,
  initTccPromptNotice,
  releasePendingTccPromptNotice,
  resetTccPromptNoticeForTests,
  stopTccPromptNotice
} = await import('./macos-tcc-prompt-notice')

beforeEach(() => {
  resetTccPromptNoticeForTests()
  watchOptions.length = 0
  watchStart.mockClear()
  watchStop.mockClear()
  writeFileAtomically.mockClear()
  readTallyFile.mockReset()
  readTallyFile.mockImplementation(() => {
    throw new Error('ENOENT')
  })
})

describe('tcc prompt notice threshold', () => {
  it('fires on the first dialog, then stays silent', () => {
    expect(handleTccPromptForTests()).toEqual({
      promptCount: TCC_PROMPT_NOTICE_THRESHOLD
    })

    expect(handleTccPromptForTests()).toBeNull()
    expect(handleTccPromptForTests()).toBeNull()
  })

  it('persists the tally on every prompt so the count survives relaunch', () => {
    handleTccPromptForTests()
    expect(writeFileAtomically).toHaveBeenCalledTimes(1)
    const [, contents] = writeFileAtomically.mock.calls[0] as [string, string]
    expect(JSON.parse(contents)).toMatchObject({ promptCount: 1, notified: false })
  })

  it('never fires again once dismissed, even past the threshold', () => {
    dismissTccPromptNotice()
    for (let i = 0; i < TCC_PROMPT_NOTICE_THRESHOLD + 2; i += 1) {
      expect(handleTccPromptForTests()).toBeNull()
    }
  })

  it('stops tally writes after the one-time notice fires', () => {
    for (let i = 0; i < TCC_PROMPT_NOTICE_THRESHOLD; i += 1) {
      handleTccPromptForTests()
    }
    writeFileAtomically.mockClear()

    expect(handleTccPromptForTests()).toBeNull()
    expect(writeFileAtomically).not.toHaveBeenCalled()
  })

  it('retains the threshold until the renderer acknowledges its claim', () => {
    for (let i = 0; i < TCC_PROMPT_NOTICE_THRESHOLD; i += 1) {
      handleTccPromptForTests()
    }
    writeFileAtomically.mockClear()

    const claim = consumePendingTccPromptNotice(1)
    expect(claim).toEqual({
      claimId: 1,
      promptCount: TCC_PROMPT_NOTICE_THRESHOLD
    })
    expect(consumePendingTccPromptNotice(2)).toBeNull()
    expect(writeFileAtomically).not.toHaveBeenCalled()
    acknowledgePendingTccPromptNotice(1, claim!.claimId)
    expect(consumePendingTccPromptNotice(2)).toBeNull()
    expect(writeFileAtomically).toHaveBeenCalledOnce()
    const [, contents] = writeFileAtomically.mock.calls.at(-1) as [string, string]
    expect(JSON.parse(contents)).toMatchObject({
      promptCount: TCC_PROMPT_NOTICE_THRESHOLD,
      notified: true,
      acknowledgedAfterClose: true
    })
  })

  it('releases an unacknowledged claim for a replacement renderer', () => {
    for (let i = 0; i < TCC_PROMPT_NOTICE_THRESHOLD; i += 1) {
      handleTccPromptForTests()
    }

    const oldClaim = consumePendingTccPromptNotice(1)
    releasePendingTccPromptNotice(1, oldClaim!.claimId + 1)
    expect(consumePendingTccPromptNotice(2)).toBeNull()
    releasePendingTccPromptNotice(1, oldClaim!.claimId)
    const replacementClaim = consumePendingTccPromptNotice(2)

    expect(oldClaim).toEqual({ claimId: 1, promptCount: TCC_PROMPT_NOTICE_THRESHOLD })
    expect(replacementClaim).toEqual({ claimId: 2, promptCount: TCC_PROMPT_NOTICE_THRESHOLD })
    acknowledgePendingTccPromptNotice(1, oldClaim!.claimId)
    releasePendingTccPromptNotice(2)
    expect(consumePendingTccPromptNotice(3)).toEqual({
      claimId: 3,
      promptCount: TCC_PROMPT_NOTICE_THRESHOLD
    })
  })

  it('invalidates an outstanding claim when the user dismisses the notice', () => {
    for (let i = 0; i < TCC_PROMPT_NOTICE_THRESHOLD; i += 1) {
      handleTccPromptForTests()
    }
    const claim = consumePendingTccPromptNotice(1)

    dismissTccPromptNotice()
    acknowledgePendingTccPromptNotice(1, claim!.claimId)

    expect(consumePendingTccPromptNotice(2)).toBeNull()
    const [, contents] = writeFileAtomically.mock.calls.at(-1) as [string, string]
    expect(JSON.parse(contents)).toMatchObject({
      dismissed: true,
      notified: true,
      acknowledgedAfterClose: true
    })
  })

  it('routes a later prompt to the replacement main window', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    const oldWindow = createWindowStub()
    const newWindow = createWindowStub()
    try {
      initTccPromptNotice(oldWindow as never)
      initTccPromptNotice(newWindow as never)
      for (let i = 0; i < TCC_PROMPT_NOTICE_THRESHOLD; i += 1) {
        watchOptions[0].onPrompt()
      }
      expect(oldWindow.webContents.send).not.toHaveBeenCalled()
      expect(newWindow.webContents.send).toHaveBeenCalledTimes(1)
      expect(watchStop).toHaveBeenCalledTimes(1)
    } finally {
      Object.defineProperty(process, 'platform', platform!)
    }
  })

  it('starts the log reader only after the first window is ready to show', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    const mainWindow = createWindowStub()
    try {
      initTccPromptNotice(mainWindow as never, { deferWatchUntilReadyToShow: true })
      expect(watchStart).not.toHaveBeenCalled()

      const readyToShow = mainWindow.once.mock.calls.find(
        ([event]) => event === 'ready-to-show'
      )?.[1]
      readyToShow?.()
      await new Promise((resolve) => {
        setImmediate(resolve)
      })

      expect(watchStart).toHaveBeenCalledOnce()
    } finally {
      Object.defineProperty(process, 'platform', platform!)
    }
  })

  it('starts immediately when startup deferral is not requested', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    try {
      initTccPromptNotice(createWindowStub() as never)
      expect(watchStart).toHaveBeenCalledOnce()
    } finally {
      Object.defineProperty(process, 'platform', platform!)
    }
  })

  it('starts once from the fallback when ready-to-show never arrives', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    vi.useFakeTimers()
    const mainWindow = createWindowStub()
    try {
      initTccPromptNotice(mainWindow as never, { deferWatchUntilReadyToShow: true })
      await vi.advanceTimersByTimeAsync(TCC_PROMPT_WATCH_START_FALLBACK_MS)
      await vi.runAllTimersAsync()

      expect(watchStart).toHaveBeenCalledOnce()
      const readyToShow = mainWindow.once.mock.calls.find(
        ([event]) => event === 'ready-to-show'
      )?.[1]
      readyToShow?.()
      await vi.runAllTimersAsync()
      expect(watchStart).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
      Object.defineProperty(process, 'platform', platform!)
    }
  })

  it('invalidates deferred starts across repeated init and stop', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    const oldWindow = createWindowStub()
    const newWindow = createWindowStub()
    try {
      initTccPromptNotice(oldWindow as never, { deferWatchUntilReadyToShow: true })
      const oldReady = oldWindow.once.mock.calls.find(([event]) => event === 'ready-to-show')?.[1]
      initTccPromptNotice(newWindow as never, { deferWatchUntilReadyToShow: true })
      const newReady = newWindow.once.mock.calls.find(([event]) => event === 'ready-to-show')?.[1]

      oldReady?.()
      await new Promise((resolve) => {
        setImmediate(resolve)
      })
      expect(watchStart).not.toHaveBeenCalled()

      stopTccPromptNotice()
      newReady?.()
      await new Promise((resolve) => {
        setImmediate(resolve)
      })
      expect(watchStart).not.toHaveBeenCalled()
      expect(watchStop).toHaveBeenCalledOnce()
    } finally {
      Object.defineProperty(process, 'platform', platform!)
    }
  })

  it('does not send through a destroyed main window', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    const mainWindow = createWindowStub()
    mainWindow.isDestroyed.mockReturnValue(true)
    try {
      initTccPromptNotice(mainWindow as never)
      expect(() => {
        for (let i = 0; i < TCC_PROMPT_NOTICE_THRESHOLD; i += 1) {
          watchOptions[0].onPrompt()
        }
      }).not.toThrow()
      expect(mainWindow.webContents.send).not.toHaveBeenCalled()
      expect(watchStop).toHaveBeenCalledTimes(1)
      expect(consumePendingTccPromptNotice(1)).toEqual({
        claimId: 1,
        promptCount: TCC_PROMPT_NOTICE_THRESHOLD
      })
    } finally {
      Object.defineProperty(process, 'platform', platform!)
    }
  })

  it('retains the threshold and stops watching when renderer delivery throws', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    const mainWindow = createWindowStub()
    mainWindow.webContents.send.mockImplementation(() => {
      throw new Error('renderer unavailable')
    })
    try {
      initTccPromptNotice(mainWindow as never)
      expect(() => {
        for (let i = 0; i < TCC_PROMPT_NOTICE_THRESHOLD; i += 1) {
          watchOptions[0].onPrompt()
        }
      }).not.toThrow()

      expect(watchStop).toHaveBeenCalledOnce()
      expect(consumePendingTccPromptNotice(1)).toEqual({
        claimId: 1,
        promptCount: TCC_PROMPT_NOTICE_THRESHOLD
      })
    } finally {
      Object.defineProperty(process, 'platform', platform!)
    }
  })

  it.each([
    { promptCount: 2, notified: false },
    { promptCount: 1, notified: true }
  ])('requires a fresh detection for a legacy tally: $promptCount/$notified', (persisted) => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    readTallyFile.mockReturnValue(JSON.stringify({ ...persisted, dismissed: false }))
    try {
      const mainWindow = createWindowStub()
      initTccPromptNotice(mainWindow as never)

      expect(watchStart).toHaveBeenCalledOnce()
      expect(mainWindow.webContents.send).not.toHaveBeenCalled()
      expect(consumePendingTccPromptNotice(1)).toBeNull()

      watchOptions[0].onPrompt()

      expect(mainWindow.webContents.send).toHaveBeenCalledWith('macosTccPrompts:threshold', {
        promptCount: 1
      })
      expect(watchStop).toHaveBeenCalledOnce()
      expect(consumePendingTccPromptNotice(1)).toEqual({ claimId: 1, promptCount: 1 })
    } finally {
      Object.defineProperty(process, 'platform', platform!)
    }
  })

  it('replays an unclosed notice from the new delivery contract', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    readTallyFile.mockReturnValue(
      JSON.stringify({
        promptCount: 1,
        notified: false,
        dismissed: false,
        acknowledgedAfterClose: false
      })
    )
    try {
      const mainWindow = createWindowStub()
      initTccPromptNotice(mainWindow as never)

      expect(watchStart).not.toHaveBeenCalled()
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('macosTccPrompts:threshold', {
        promptCount: 1
      })
      expect(consumePendingTccPromptNotice(1)).toEqual({ claimId: 1, promptCount: 1 })
    } finally {
      Object.defineProperty(process, 'platform', platform!)
    }
  })

  it('does not replay a notice acknowledged after close', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    readTallyFile.mockReturnValue(
      JSON.stringify({
        promptCount: 1,
        notified: true,
        dismissed: false,
        acknowledgedAfterClose: true
      })
    )
    try {
      const mainWindow = createWindowStub()
      initTccPromptNotice(mainWindow as never)

      expect(watchStart).not.toHaveBeenCalled()
      expect(mainWindow.webContents.send).not.toHaveBeenCalled()
      expect(consumePendingTccPromptNotice(1)).toBeNull()
    } finally {
      Object.defineProperty(process, 'platform', platform!)
    }
  })

  it('does not let a late old-window close clear the replacement target', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    const oldWindow = createWindowStub()
    const newWindow = createWindowStub()
    try {
      initTccPromptNotice(oldWindow as never)
      const oldClosed = oldWindow.once.mock.calls.find(([event]) => event === 'closed')?.[1]
      initTccPromptNotice(newWindow as never)
      oldClosed?.()
      for (let i = 0; i < TCC_PROMPT_NOTICE_THRESHOLD; i += 1) {
        watchOptions[0].onPrompt()
      }

      expect(oldWindow.webContents.send).not.toHaveBeenCalled()
      expect(newWindow.webContents.send).toHaveBeenCalledTimes(1)
    } finally {
      Object.defineProperty(process, 'platform', platform!)
    }
  })
})

function createWindowStub() {
  return {
    isDestroyed: vi.fn(() => false),
    once: vi.fn(),
    webContents: {
      isDestroyed: vi.fn(() => false),
      send: vi.fn()
    }
  }
}
