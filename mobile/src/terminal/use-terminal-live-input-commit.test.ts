import { createElement, type RefObject } from 'react'
import { act, create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { noteImeCompositionChange } from '../ime/ime-submit-carry'
import type { TerminalLiveInputSender } from './terminal-live-input-sender'
import { useTerminalLiveInputCommit } from './use-terminal-live-input-commit'

const frames: Array<() => void> = []

function flushFrame(): void {
  const pending = frames.splice(0)
  for (const callback of pending) {
    callback()
  }
}

beforeEach(() => {
  frames.length = 0
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => {
    frames.push(callback)
    return frames.length
  })
  // Why: the IME submit carry is module state, so a prior test's marked event would otherwise
  // make this test's first unmarked event look like a confirmation. Android never arms it.
  noteImeCompositionChange('android', true)
  noteImeCompositionChange('android', false)
})

type Handlers = ReturnType<typeof useTerminalLiveInputCommit<string>>

type RecordedChange = {
  readonly text: string
  readonly isComposing: boolean
  readonly replacementText: string
  readonly start: number
  readonly end: number
}

const RECORDED_IOS_KANA_TRACE: readonly RecordedChange[] = [
  { text: 'あ', isComposing: true, replacementText: 'あ', start: 0, end: 0 },
  { text: 'あ', isComposing: true, replacementText: 'あ', start: 0, end: 1 },
  { text: 'あ', isComposing: false, replacementText: 'あ', start: 0, end: 1 },
  { text: 'あき', isComposing: true, replacementText: 'き', start: 1, end: 1 },
  { text: 'あき', isComposing: true, replacementText: 'き', start: 1, end: 2 },
  { text: 'あき', isComposing: false, replacementText: 'き', start: 1, end: 2 },
  { text: 'あきか', isComposing: true, replacementText: 'か', start: 2, end: 2 },
  { text: 'あきかな', isComposing: true, replacementText: 'な', start: 3, end: 3 },
  { text: 'あきカナ', isComposing: true, replacementText: 'カナ', start: 2, end: 4 },
  { text: 'あきカナ', isComposing: false, replacementText: 'カナ', start: 2, end: 4 },
  { text: 'あきカナさ', isComposing: true, replacementText: 'さ', start: 4, end: 4 },
  { text: 'あきカナ', isComposing: false, replacementText: '', start: 4, end: 5 }
]

const RECORDED_IOS_7427_TRACE: readonly RecordedChange[] = [
  { text: 'つ', isComposing: true, replacementText: 'つ', start: 0, end: 0 },
  { text: 'っ', isComposing: true, replacementText: '゛', start: 1, end: 1 },
  { text: 'っ', isComposing: true, replacementText: 'っ', start: 0, end: 1 },
  { text: 'っ', isComposing: false, replacementText: 'っ', start: 0, end: 1 },
  { text: 'っか', isComposing: true, replacementText: 'か', start: 1, end: 1 },
  { text: 'っが', isComposing: true, replacementText: '゛', start: 2, end: 2 },
  { text: 'っが', isComposing: true, replacementText: 'が', start: 1, end: 2 },
  { text: 'っが', isComposing: false, replacementText: 'が', start: 1, end: 2 },
  { text: 'っがは', isComposing: true, replacementText: 'は', start: 2, end: 2 },
  { text: 'っがば', isComposing: true, replacementText: '゛', start: 3, end: 3 },
  { text: 'っがぱ', isComposing: true, replacementText: '゛', start: 3, end: 3 },
  { text: 'っがぱ', isComposing: true, replacementText: 'ぱ', start: 2, end: 3 },
  { text: 'っがぱ', isComposing: false, replacementText: 'ぱ', start: 2, end: 3 },
  { text: 'っがぱs', isComposing: true, replacementText: 's', start: 3, end: 3 },
  { text: 'っがぱさ', isComposing: true, replacementText: 'a', start: 4, end: 4 },
  { text: 'っがぱさ', isComposing: true, replacementText: 'さ', start: 3, end: 4 },
  { text: 'っがぱさ', isComposing: false, replacementText: 'さ', start: 3, end: 4 },
  { text: 'っがぱさk', isComposing: true, replacementText: 'k', start: 4, end: 4 },
  { text: 'っがぱさか', isComposing: true, replacementText: 'a', start: 5, end: 5 },
  { text: 'っがぱさかn', isComposing: true, replacementText: 'n', start: 5, end: 5 },
  { text: 'っがぱさかんj', isComposing: true, replacementText: 'j', start: 6, end: 6 },
  { text: 'っがぱさかんじ', isComposing: true, replacementText: 'i', start: 7, end: 7 },
  { text: 'っがぱさ漢字', isComposing: true, replacementText: '漢字', start: 4, end: 7 },
  { text: 'っがぱさ漢字', isComposing: false, replacementText: '漢字', start: 4, end: 7 },
  { text: 'っがぱさ漢字k', isComposing: true, replacementText: 'k', start: 6, end: 6 },
  { text: 'っがぱさ漢字か', isComposing: true, replacementText: 'a', start: 7, end: 7 },
  { text: 'っがぱさ漢字かn', isComposing: true, replacementText: 'n', start: 7, end: 7 },
  { text: 'っがぱさ漢字かな', isComposing: true, replacementText: 'a', start: 8, end: 8 },
  { text: 'っがぱさ漢字かな', isComposing: true, replacementText: 'かな', start: 6, end: 8 },
  { text: 'っがぱさ漢字かな', isComposing: false, replacementText: 'かな', start: 6, end: 8 }
]

// Captured on a physical iPhone 13 Pro Max, iOS 26.5.2, system Japanese Kana keyboard
// (lane-ios/metro.log, IME7427_NATIVE_EVENT eventCount 5-10). The same capture arm recorded
// 13 PTY bytes: the 12 expected UTF-8 bytes for いうえお plus a trailing 0d.
const RECORDED_IOS_DEVICE_FLICK_VOWELS_TRACE: readonly RecordedChange[] = [
  { text: 'い', isComposing: true, replacementText: 'い', start: 0, end: 0 },
  { text: 'いう', isComposing: true, replacementText: 'う', start: 1, end: 1 },
  { text: 'いうえ', isComposing: true, replacementText: 'え', start: 2, end: 2 },
  { text: 'いうえお', isComposing: true, replacementText: 'お', start: 3, end: 3 },
  { text: 'いうえお', isComposing: true, replacementText: 'いうえお', start: 0, end: 4 },
  { text: 'いうえお', isComposing: false, replacementText: 'いうえお', start: 0, end: 4 }
]

const RECORDED_ANDROID_FCITX_HANGUL_TRACE: readonly RecordedChange[] = [
  { text: 'ㅎ', isComposing: true, replacementText: 'ㅎ', start: 0, end: 0 },
  { text: '하', isComposing: true, replacementText: '하', start: 0, end: 1 },
  { text: '한', isComposing: true, replacementText: '한', start: 0, end: 1 },
  { text: '한', isComposing: false, replacementText: '한', start: 0, end: 1 },
  { text: '한ㄱ', isComposing: true, replacementText: 'ㄱ', start: 1, end: 1 },
  { text: '한그', isComposing: true, replacementText: '그', start: 1, end: 2 },
  { text: '한글', isComposing: true, replacementText: '글', start: 1, end: 2 },
  { text: '한글', isComposing: false, replacementText: '글', start: 1, end: 2 }
]

const RECORDED_ANDROID_FCITX_HANGUL_CANCELLATION_TRACE: readonly RecordedChange[] = [
  { text: 'ㅎ', isComposing: true, replacementText: 'ㅎ', start: 0, end: 0 },
  { text: '하', isComposing: true, replacementText: '하', start: 0, end: 1 },
  { text: '한', isComposing: true, replacementText: '한', start: 0, end: 1 },
  { text: '하', isComposing: true, replacementText: '하', start: 0, end: 1 },
  { text: 'ㅎ', isComposing: true, replacementText: 'ㅎ', start: 0, end: 1 },
  { text: '', isComposing: true, replacementText: '', start: 0, end: 1 },
  { text: '', isComposing: false, replacementText: '', start: 0, end: 1 }
]

const RECORDED_ANDROID_FCITX_ANTHY_TRACE: readonly RecordedChange[] = [
  { text: 's', isComposing: true, replacementText: 's', start: 0, end: 0 },
  { text: 'さ', isComposing: true, replacementText: 'さ', start: 0, end: 1 },
  { text: 'さ', isComposing: false, replacementText: 'さ', start: 0, end: 1 }
]

const RECORDED_ANDROID_FCITX_ANTHY_CANCELLATION_TRACE: readonly RecordedChange[] = [
  { text: 's', isComposing: true, replacementText: 's', start: 0, end: 0 },
  { text: 'さ', isComposing: true, replacementText: 'さ', start: 0, end: 1 },
  { text: '', isComposing: true, replacementText: '', start: 0, end: 1 },
  { text: '', isComposing: false, replacementText: '', start: 0, end: 1 }
]

const ORDINARY_ABC_TRACE: readonly RecordedChange[] = [
  { text: 'a', isComposing: false, replacementText: 'a', start: 0, end: 0 },
  { text: 'ab', isComposing: false, replacementText: 'b', start: 1, end: 1 },
  { text: 'abc', isComposing: false, replacementText: 'c', start: 2, end: 2 }
]

const RECORDED_IOS_KOREAN_TRANSFORM_TRACE: readonly RecordedChange[] = [
  { text: 'ㅇ', isComposing: false, replacementText: 'ㅇ', start: 0, end: 0 },
  { text: '아', isComposing: false, replacementText: 'ㅏ', start: 1, end: 1 },
  { text: '안', isComposing: false, replacementText: 'ㄴ', start: 1, end: 1 },
  { text: '안ㄴ', isComposing: false, replacementText: 'ㄴ', start: 1, end: 1 },
  { text: '안녀', isComposing: false, replacementText: 'ㅕ', start: 2, end: 2 },
  { text: '안녕', isComposing: false, replacementText: 'ㅇ', start: 2, end: 2 },
  { text: '안녕ㅎ', isComposing: false, replacementText: 'ㅎ', start: 2, end: 2 },
  { text: '안녕하', isComposing: false, replacementText: 'ㅏ', start: 3, end: 3 },
  { text: '안녕핫', isComposing: false, replacementText: 'ㅅ', start: 3, end: 3 },
  { text: '안녕하세', isComposing: false, replacementText: 'ㅔ', start: 3, end: 3 },
  { text: '안녕하셍', isComposing: false, replacementText: 'ㅇ', start: 4, end: 4 },
  { text: '안녕하세요', isComposing: false, replacementText: 'ㅛ', start: 4, end: 4 }
]

const RECORDED_ANDROID_GBOARD_BACKSPACE_TRACE: readonly RecordedChange[] = [
  { text: 'a', isComposing: false, replacementText: 'a', start: 0, end: 0 },
  { text: '', isComposing: false, replacementText: '', start: 0, end: 1 }
]

const IOS_ROMAJI_RECORDED_PREFIX = 'あきカナたあbcabc'
const RECORDED_IOS_ROMAJI_TRACE: readonly RecordedChange[] = [
  {
    text: `${IOS_ROMAJI_RECORDED_PREFIX}k`,
    isComposing: true,
    replacementText: 'k',
    start: 11,
    end: 11
  },
  {
    text: `${IOS_ROMAJI_RECORDED_PREFIX}か`,
    isComposing: true,
    replacementText: 'a',
    start: 12,
    end: 12
  },
  {
    text: `${IOS_ROMAJI_RECORDED_PREFIX}かn`,
    isComposing: true,
    replacementText: 'n',
    start: 12,
    end: 12
  },
  {
    text: `${IOS_ROMAJI_RECORDED_PREFIX}かな`,
    isComposing: true,
    replacementText: 'a',
    start: 13,
    end: 13
  },
  {
    text: `${IOS_ROMAJI_RECORDED_PREFIX}かな`,
    isComposing: true,
    replacementText: 'かな',
    start: 11,
    end: 13
  },
  {
    text: `${IOS_ROMAJI_RECORDED_PREFIX}かな`,
    isComposing: false,
    replacementText: 'かな',
    start: 11,
    end: 13
  }
]

function createHarness(
  send?: TerminalLiveInputSender,
  platform = 'ios'
): {
  readonly captures: string[]
  readonly handlers: Handlers
  readonly sent: string[]
} {
  const activeHandle = 'terminal-a'
  const captures: string[] = []
  const sent: string[] = []
  const activeHandleRef: RefObject<string | null> = { current: activeHandle }
  const activeSessionTabTypeRef: RefObject<string | null> = { current: 'terminal' }
  const liveInputTerminalHandles = new Set([activeHandle])
  const sendLiveTerminalInputRef: RefObject<TerminalLiveInputSender> = {
    current:
      send ??
      (async (_handle, bytes) => {
        sent.push(bytes)
        return true
      })
  }
  const liveInputRef = {
    current: { setNativeProps: vi.fn() }
  }
  let handlers: Handlers | null = null

  function Harness(): null {
    handlers = useTerminalLiveInputCommit({
      activeHandle,
      activeHandleRef,
      activeSessionTabType: 'terminal',
      activeSessionTabTypeRef,
      connected: true,
      liveInputRef,
      liveInputTerminalHandles,
      liveInputTerminalHandlesRef: { current: liveInputTerminalHandles },
      platform,
      sendLiveTerminalInputRef,
      setLiveInputCapture: (text) => captures.push(text)
    })
    return null
  }

  const originalConsoleError = console.error
  const consoleError = vi.spyOn(console, 'error').mockImplementation((...args) => {
    if (typeof args[0] !== 'string' || !args[0].includes('react-test-renderer is deprecated')) {
      originalConsoleError(...args)
    }
  })
  try {
    act(() => {
      create(createElement(Harness))
    })
  } finally {
    consoleError.mockRestore()
  }
  if (!handlers) {
    throw new Error('terminal live input hook did not render')
  }
  return { captures, handlers, sent }
}

function change(handlers: Handlers, event: RecordedChange): void {
  handlers.handleLiveInputChange({
    nativeEvent: {
      text: event.text,
      isComposing: event.isComposing,
      replacementText: event.replacementText,
      replacementRange: { start: event.start, end: event.end }
    }
  })
}

function replay(handlers: Handlers, trace: readonly RecordedChange[]): void {
  for (const event of trace) {
    change(handlers, event)
  }
}

describe('terminal live input commit hook', () => {
  it('replays the recorded Android Fcitx Hangul commit and Enter trace', async () => {
    const { handlers, sent } = createHarness(undefined, 'android')

    replay(handlers, RECORDED_ANDROID_FCITX_HANGUL_TRACE.slice(0, 3))
    expect(sent).toEqual([])

    change(handlers, RECORDED_ANDROID_FCITX_HANGUL_TRACE[3])
    await vi.waitFor(() => expect(sent).toEqual(['한']))

    replay(handlers, RECORDED_ANDROID_FCITX_HANGUL_TRACE.slice(4, 7))
    expect(sent).toEqual(['한'])

    change(handlers, RECORDED_ANDROID_FCITX_HANGUL_TRACE[7])
    handlers.handleLiveInputSubmit()
    await vi.waitFor(() => expect(sent).toEqual(['한', '글', '\r']))
  })

  it('replays Fcitx Hangul cancellation without leaving terminal input gated', async () => {
    const { handlers, sent } = createHarness(undefined, 'android')

    replay(handlers, RECORDED_ANDROID_FCITX_HANGUL_CANCELLATION_TRACE.slice(0, -2))
    change(handlers, RECORDED_ANDROID_FCITX_HANGUL_CANCELLATION_TRACE.at(-2)!)
    handlers.handleLiveInputKeyPress({ nativeEvent: { key: 'Backspace' } })
    change(handlers, RECORDED_ANDROID_FCITX_HANGUL_CANCELLATION_TRACE.at(-1)!)
    expect(sent).toEqual([])
    await expect(handlers.handleLiveInputAccessoryBytes({ bytes: '\r' })).resolves.toEqual({
      kind: 'allow-raw'
    })

    change(handlers, ORDINARY_ABC_TRACE[0])
    handlers.handleLiveInputSubmit()
    await vi.waitFor(() => expect(sent).toEqual(['a', '\r']))
  })

  it('replays the recorded Android Fcitx Anthy trace with an English control', async () => {
    const { handlers, sent } = createHarness(undefined, 'android')

    replay(handlers, RECORDED_ANDROID_FCITX_ANTHY_TRACE.slice(0, -1))
    expect(sent).toEqual([])
    change(handlers, RECORDED_ANDROID_FCITX_ANTHY_TRACE.at(-1)!)
    await vi.waitFor(() => expect(sent).toEqual(['さ']))
    await expect(handlers.handleLiveInputAccessoryBytes({ bytes: '\r' })).resolves.toEqual({
      kind: 'allow-raw'
    })

    replay(handlers, RECORDED_ANDROID_FCITX_ANTHY_CANCELLATION_TRACE)
    expect(sent).toEqual(['さ'])

    change(handlers, ORDINARY_ABC_TRACE[0])
    await vi.waitFor(() => expect(sent).toEqual(['さ', 'a']))
  })

  it('keeps the recorded Pinyin preedit native and sends only its candidate commit', async () => {
    const { captures, handlers, sent } = createHarness()

    const preedit = [
      { text: 'z', replacementText: 'z', start: 0 },
      { text: 'zh', replacementText: 'h', start: 1 },
      { text: 'zho', replacementText: 'o', start: 2 },
      { text: 'zhon', replacementText: 'n', start: 3 },
      { text: 'zhong', replacementText: 'g', start: 4 }
    ]
    for (const event of preedit) {
      change(handlers, {
        ...event,
        isComposing: true,
        end: event.start
      })
    }
    expect(sent).toEqual([])

    change(handlers, {
      text: '中',
      isComposing: true,
      replacementText: '中',
      start: 0,
      end: 5
    })
    expect(sent).toEqual([])

    change(handlers, {
      text: '中',
      isComposing: false,
      replacementText: '中',
      start: 0,
      end: 5
    })

    await vi.waitFor(() => expect(sent).toEqual(['中']))
    expect(captures).toEqual(['z', 'zh', 'zho', 'zhon', 'zhong', '中', '中'])
  })

  it('replays the recorded Gboard Backspace replacement exactly once', async () => {
    const { handlers, sent } = createHarness(undefined, 'android')

    change(handlers, RECORDED_ANDROID_GBOARD_BACKSPACE_TRACE[0])
    handlers.handleLiveInputKeyPress({ nativeEvent: { key: 'Backspace' } })
    change(handlers, RECORDED_ANDROID_GBOARD_BACKSPACE_TRACE[1])

    await vi.waitFor(() => expect(sent).toEqual(['a', '\x7f']))
  })

  it('preserves rapid input order while transport sends are delayed', async () => {
    const started: string[] = []
    const delivered: string[] = []
    const release: Array<() => void> = []
    const { handlers } = createHarness(
      async (_handle, bytes) =>
        new Promise<boolean>((resolve) => {
          started.push(bytes)
          release.push(() => {
            delivered.push(bytes)
            resolve(true)
          })
        })
    )

    replay(handlers, ORDINARY_ABC_TRACE)

    await vi.waitFor(() => expect(started).toEqual(['a']))
    release.shift()!()
    await vi.waitFor(() => expect(started).toEqual(['a', 'b']))
    release.shift()!()
    await vi.waitFor(() => expect(started).toEqual(['a', 'b', 'c']))
    release.shift()!()
    await vi.waitFor(() => expect(delivered).toEqual(['a', 'b', 'c']))
  })

  it('replays the recorded iOS Kana tap, flick, candidate, and cancellation trace', async () => {
    const { handlers, sent } = createHarness()

    change(handlers, RECORDED_IOS_KANA_TRACE[0])
    await expect(handlers.handleLiveInputAccessoryBytes({ bytes: '\r' })).resolves.toEqual({
      kind: 'suppress-raw'
    })
    replay(handlers, RECORDED_IOS_KANA_TRACE.slice(1))

    await vi.waitFor(() => expect(sent).toEqual(['あ', 'き', 'カナ']))
  })

  it('replays the recorded iOS Japanese Romaji candidate trace', async () => {
    const { handlers, sent } = createHarness()
    change(handlers, {
      text: IOS_ROMAJI_RECORDED_PREFIX,
      isComposing: false,
      replacementText: IOS_ROMAJI_RECORDED_PREFIX,
      start: 0,
      end: 0
    })
    await vi.waitFor(() => expect(sent).toEqual([IOS_ROMAJI_RECORDED_PREFIX]))
    sent.length = 0

    replay(handlers, RECORDED_IOS_ROMAJI_TRACE)

    await vi.waitFor(() => expect(sent).toEqual(['かな']))
  })

  it('replays the recorded iOS #7427 transforms, confirmation, and English control', async () => {
    const japanese = createHarness()
    replay(japanese.handlers, RECORDED_IOS_7427_TRACE)
    await vi.waitFor(() => expect(japanese.sent).toEqual(['っ', 'が', 'ぱ', 'さ', '漢字', 'かな']))
    expect(japanese.sent).not.toContain('\r')

    const english = createHarness()
    replay(english.handlers, ORDINARY_ABC_TRACE)
    await vi.waitFor(() => expect(english.sent).toEqual(['a', 'b', 'c']))
  })

  it('replays iOS Korean post-change transforms without normalizing text', async () => {
    const korean = createHarness()
    replay(korean.handlers, RECORDED_IOS_KOREAN_TRANSFORM_TRACE)
    korean.handlers.handleLiveInputSubmit()

    await vi.waitFor(() => expect(korean.sent.at(-1)).toBe('\r'))
    const terminalText = korean.sent
      .join('')
      .split('')
      .reduce((text, character) =>
        character === '\x7f' ? Array.from(text).slice(0, -1).join('') : text + character
      )
    expect(terminalText).toBe('안녕하세요\r')

    const english = createHarness()
    replay(english.handlers, ORDINARY_ABC_TRACE)
    await vi.waitFor(() => expect(english.sent).toEqual(['a', 'b', 'c']))
  })

  it('emits nothing for the recorded Pinyin cancellation trace', () => {
    const { handlers, sent } = createHarness()
    const changes = [
      { text: 'z', isComposing: true, replacementText: 'z', start: 0, end: 0 },
      { text: 'zh', isComposing: true, replacementText: 'h', start: 1, end: 1 },
      { text: 'z', isComposing: true, replacementText: '', start: 1, end: 2 },
      { text: '', isComposing: false, replacementText: '', start: 0, end: 1 }
    ]
    for (const event of changes) {
      change(handlers, event)
    }
    expect(sent).toEqual([])
  })

  it('suppresses submit and accessory controls until native composition ends', async () => {
    const { handlers, sent } = createHarness()
    change(handlers, {
      text: 'zhong',
      isComposing: true,
      replacementText: 'zhong',
      start: 0,
      end: 0
    })

    handlers.handleLiveInputSubmit()
    await expect(handlers.handleLiveInputAccessoryBytes({ bytes: '\t' })).resolves.toEqual({
      kind: 'suppress-raw'
    })
    expect(sent).toEqual([])
  })

  it('blocks sends when native replacement evidence is absent', async () => {
    const { handlers, sent } = createHarness()
    handlers.handleLiveInputChange({
      nativeEvent: {
        text: 'mutable snapshot'
      } as never
    })
    handlers.handleLiveInputSubmit()
    expect(sent).toEqual([])
    await expect(handlers.handleLiveInputAccessoryBytes({ bytes: '\r' })).resolves.toEqual({
      kind: 'suppress-raw'
    })
  })

  it('blocks an incomplete command until native evidence reconciles', async () => {
    const { handlers, sent } = createHarness()
    change(handlers, ORDINARY_ABC_TRACE[0])
    change(handlers, {
      text: 'ab',
      isComposing: false,
      replacementText: 'b',
      start: -1,
      end: 1
    })

    handlers.handleLiveInputSubmit()
    await expect(handlers.handleLiveInputAccessoryBytes({ bytes: '\r' })).resolves.toEqual({
      kind: 'suppress-raw'
    })
    expect(sent).toEqual(['a'])

    change(handlers, ORDINARY_ABC_TRACE[1])
    handlers.handleLiveInputSubmit()
    await vi.waitFor(() => expect(sent).toEqual(['a', 'b', '\r']))
  })

  it('drops the iOS device confirmation submit and keeps the ASCII control armed', async () => {
    const japanese = createHarness()
    replay(japanese.handlers, RECORDED_IOS_DEVICE_FLICK_VOWELS_TRACE)
    japanese.handlers.handleLiveInputSubmit()

    // Why: assert the drained queue, not a transient one — a suppressed '\r' and a '\r' that has
    // merely not landed yet are indistinguishable while sends are still in flight.
    await japanese.handlers.flushPendingLiveInputBeforeExternalSend('terminal-a')
    expect(japanese.sent).toEqual(['いうえお'])
    expect(Buffer.from(japanese.sent.join(''), 'utf8').toString('hex')).toBe(
      'e38184e38186e38188e3818a'
    )

    const english = createHarness()
    replay(english.handlers, ORDINARY_ABC_TRACE)
    english.handlers.handleLiveInputSubmit()
    await english.handlers.flushPendingLiveInputBeforeExternalSend('terminal-a')
    expect(english.sent).toEqual(['a', 'b', 'c', '\r'])
    expect(Buffer.from(english.sent.join(''), 'utf8').toString('hex')).toBe('6162630d')
  })

  it('sends a deliberate Return taken one frame after the iOS device confirmation', async () => {
    const { handlers, sent } = createHarness()
    replay(handlers, RECORDED_IOS_DEVICE_FLICK_VOWELS_TRACE)
    await vi.waitFor(() => expect(sent).toEqual(['いうえお']))

    flushFrame()
    handlers.handleLiveInputSubmit()
    await vi.waitFor(() => expect(sent).toEqual(['いうえお', '\r']))
  })

  it('keeps the unmarking iOS Korean keyboard submitting on the confirming Return', async () => {
    const { handlers, sent } = createHarness()
    replay(handlers, RECORDED_IOS_KOREAN_TRANSFORM_TRACE)
    handlers.handleLiveInputSubmit()

    await vi.waitFor(() => expect(sent.at(-1)).toBe('\r'))
  })
})
