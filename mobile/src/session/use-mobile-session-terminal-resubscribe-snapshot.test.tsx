import { Terminal } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TerminalInit, TerminalWebViewHandle } from '../terminal/terminal-webview-contract'
import { MobileTerminalDiagnostics } from './mobile-terminal-diagnostics'
import { TerminalViewportResubscribeBudget } from './mobile-terminal-viewport-resubscribe'
import type { MobileSessionNativeChatDictationModel } from './use-mobile-session-native-chat-dictation'
import { useMobileSessionTerminalSubscription } from './use-mobile-session-terminal-subscription'
import {
  useMobileSessionTerminalSubscriptionFoundation,
  type MobileSessionTerminalSubscriptionFoundationModel
} from './use-mobile-session-terminal-subscription-foundation'

const HANDLE = 'term-1'
const COLS = 40
const ROWS = 12

const writeSync = (term: Terminal, data: string): Promise<void> =>
  new Promise((resolve) => term.write(data, resolve))

function screen(term: Terminal): string[] {
  const buf = term.buffer.active
  return Array.from(
    { length: term.rows },
    (_, y) => buf.getLine(buf.viewportY + y)?.translateToString(true) ?? ''
  )
}

function liveBlockTui() {
  let prev: string[] = []
  const block = (status: string): string[] => [
    `* ${status}`,
    '+' + '-'.repeat(COLS - 2) + '+',
    '| > ' + ' '.repeat(COLS - 6) + ' |',
    '+' + '-'.repeat(COLS - 2) + '+'
  ]
  return {
    first(status: string): string {
      prev = block(status)
      return prev.join('\r\n') + '\r'
    },
    frame(status: string): string {
      const next = block(status)
      let out = `\x1b[${prev.length - 1}A`
      next.forEach((line, y) => {
        const old = prev[y] ?? ''
        for (let x = 0; x < line.length; x++) {
          if (old[x] !== line[x]) {
            out += `\x1b[${x + 1}G${line[x]}`
          }
        }
        if (old.length > line.length) {
          out += `\x1b[${line.length + 1}G\x1b[K`
        }
        out += y < next.length - 1 ? '\x1b[1B' : ''
      })
      prev = next
      return out + '\r'
    }
  }
}

let renderer: ReactTestRenderer | undefined

function harness(phone: Terminal) {
  const handlers: ((result: unknown) => void)[] = []
  const pending: Promise<void>[] = []
  const terminal: TerminalWebViewHandle = {
    prepareForForegroundRecovery: vi.fn(),
    write: vi.fn((data: string) => void pending.push(writeSync(phone, data))),
    init: vi.fn(({ initialData = '' }: TerminalInit) => {
      phone.reset()
      pending.push(writeSync(phone, initialData))
    }),
    resize: vi.fn(),
    reflow: vi.fn(),
    clear: vi.fn(),
    fitDimensions: vi.fn(() => ({ cols: COLS, rows: ROWS })),
    resetZoom: vi.fn(),
    cancelSelect: vi.fn(),
    doSelectAll: vi.fn(),
    awaitReady: vi.fn(async () => {})
  }
  const fields = {
    client: {
      subscribe: vi.fn((_m: string, _p: unknown, onData: (r: unknown) => void) => {
        handlers.push(onData)
        return () => {}
      })
    },
    clientId: 'client-1',
    setTerminalModes: vi.fn(),
    setCoveredStreamRevision: vi.fn(),
    setTerminalKeyboardMetrics: vi.fn(),
    terminalCwdRef: { current: new Map() },
    terminalRefs: { current: new Map([[HANDLE, terminal]]) },
    viewportRef: { current: { cols: COLS, rows: ROWS } },
    viewportMeasuredRef: { current: true },
    terminalUnsubsRef: { current: new Map<string, () => void>() },
    subscribingHandlesRef: { current: new Set<string>() },
    leaseOnlyHandlesRef: { current: new Set<string>() },
    initializedHandlesRef: { current: new Set<string>() },
    terminalDiagnosticsRef: { current: new MobileTerminalDiagnostics() },
    viewportResubscribeBudgetRef: { current: new TerminalViewportResubscribeBudget() },
    webReadyHandlesRef: { current: new Set<string>([HANDLE]) },
    activeHandleRef: { current: HANDLE },
    subscribeSeqRef: { current: new Map<string, number>() },
    layoutSeqRef: { current: new Map() },
    terminalFrameRef: { current: { width: 400, height: 700 } },
    nativeChatInputLeaseReadyRef: { current: false },
    clearNativeChatInputLease: vi.fn(() => false),
    showNativeChatRef: { current: false },
    scheduleDelayedAction: vi.fn(),
    showToast: vi.fn(),
    markNativeChatInputLeaseReady: vi.fn(),
    signalTerminalInventoryRecovery: vi.fn()
  }
  let subscribe: ((handle: string) => void) | undefined
  function Probe() {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the foundation reads only the fields built above.
    const base = fields as unknown as MobileSessionNativeChatDictationModel
    const foundation = useMobileSessionTerminalSubscriptionFoundation(base)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the subscription reads only these fields and the foundation's outputs.
    const scope = {
      ...fields,
      ...foundation
    } as unknown as MobileSessionTerminalSubscriptionFoundationModel
    subscribe = useMobileSessionTerminalSubscription(scope).subscribeToTerminal
    return null
  }
  act(() => {
    renderer = create(createElement(Probe))
  })
  return {
    subscribe: () => act(() => subscribe!(HANDLE)),
    emit: (frame: unknown) => act(() => handlers.at(-1)!(frame)),
    initCount: () => vi.mocked(terminal.init).mock.calls.length,
    flush: () => Promise.all(pending.splice(0))
  }
}

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = undefined
})

async function streamEndsThenResubscribes(teardown: 'end' | 'error') {
  const host = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true })
  const serializer = new SerializeAddon()
  host.loadAddon(serializer)
  const phone = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true })
  const tui = liveBlockTui()
  const page = harness(phone)
  const live = async (data: string) => {
    await writeSync(host, data)
    page.emit({ type: 'data', chunk: data })
  }

  await writeSync(host, '$ claude\r\n' + tui.first('Thinking'))
  page.subscribe()
  page.emit({
    type: 'scrollback',
    seq: 1,
    cols: COLS,
    rows: ROWS,
    serialized: serializer.serialize()
  })
  await live(tui.frame('Reading files'))

  page.emit({ type: teardown })
  await writeSync(host, tui.frame('Writing bench.ts'))
  await writeSync(host, tui.frame('Running suite'))

  page.subscribe()
  page.emit({
    type: 'scrollback',
    seq: 2,
    cols: COLS,
    rows: ROWS,
    serialized: serializer.serialize()
  })
  await live(tui.frame('Finished in 3s'))
  await page.flush()
  return { host: screen(host), phone: screen(phone), inits: page.initCount() }
}

describe('resubscribe after the stream tears down', () => {
  it.each(['end', 'error'] as const)(
    'draws the fresh snapshot after a stream `%s` frame',
    async (teardown) => {
      const { host, phone, inits } = await streamEndsThenResubscribes(teardown)
      expect(inits).toBe(2)
      expect(phone).toEqual(host)
    }
  )
})
