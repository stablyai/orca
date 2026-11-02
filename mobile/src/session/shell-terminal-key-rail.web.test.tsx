import { createElement, startTransition, Suspense } from 'react'
import { ScrollView } from 'react-native'
import { act, create } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { createBridgeClientTerminalKeys } from '../mobile-web-shell/bridge/bridge-client-terminal-keys'
import type {
  BridgeTerminalKeyId,
  BridgeTerminalToolbar
} from '../mobile-web-shell/bridge/bridge-terminal-key'

const bridge = vi.hoisted(() => ({ client: vi.fn() }))
vi.mock('../transport/client-context.web', () => ({ usePageBridgeClient: bridge.client }))
vi.mock('expo-router', async () => ({ useFocusEffect: (await import('react')).useEffect }))
vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  AppState: { addEventListener: () => ({ remove() {} }) },
  StyleSheet: { create: <T,>(styles: T) => styles }
}))
vi.mock('lucide-react-native', () => ({
  Keyboard: 'Keyboard',
  ChevronDown: 'ChevronDown',
  Monitor: 'Monitor',
  Smartphone: 'Smartphone',
  ChevronsRight: 'ChevronsRight',
  Ellipsis: 'Ellipsis'
}))
vi.mock('../layout/side-rail', () => ({
  useSideRailContent: vi.fn(),
  useSideRailDirectionPadAvailable: () => false,
  useSideRailStrip: () => ({ height: 500 })
}))
import { useShellTerminalKeyRail } from './shell-terminal-key-rail.web'
import { TerminalKeyRail } from '../mobile-web-shell/terminal-key-rail'
import { useShellKeyRail } from '../mobile-web-shell/use-shell-key-rail'

const initialToolbar: BridgeTerminalToolbar = {
  canSend: true,
  canCompose: true,
  keyboardVisible: false,
  liveInputEnabled: true,
  phoneDisplayMode: false,
  runsAgent: false,
  modifiers: { ctrl: 'off', alt: 'off', shift: 'off' }
}
let page: ReturnType<typeof create> | undefined
let native: ReturnType<typeof create> | undefined
afterEach(() => {
  act(() => {
    page?.unmount()
    native?.unmount()
  })
  page = native = undefined
})

function mount() {
  type Frame = Parameters<Parameters<typeof createBridgeClientTerminalKeys>[0]>
  const frames: Frame[] = []
  const terminal = createBridgeClientTerminalKeys((...frame) => frames.push(frame))
  let reportClaim: (...frame: Frame) => void = () => {}
  const onKey = vi.fn()
  const keys: string[] = []
  bridge.client.mockReturnValue({
    onTerminalKeyRailUpdate: () => () => {},
    getShellSession: () => ({ terminalKeyRail: keys }),
    claimTerminalKeyRail: terminal.claim
  })
  function Native() {
    const rail = useShellKeyRail({
      sessionId: 'one',
      overlay: false,
      routeGrants: ['terminalKeyRail']
    })
    reportClaim = rail.reportClaim
    return rail.keys.length
      ? createElement(TerminalKeyRail, {
          inputOwner: rail.inputOwner,
          keys: rail.keys,
          toolbar: rail.toolbar,
          onKey: () => true
        })
      : null
  }
  function Page({
    toolbar,
    shown = true,
    focusedTerminal = 'one'
  }: {
    toolbar: BridgeTerminalToolbar
    shown?: boolean
    focusedTerminal?: string
  }) {
    useShellTerminalKeyRail(shown, onKey, focusedTerminal, toolbar)
    return null
  }
  const deliver = () => {
    // Each bridge message may commit separately across the WebView boundary.
    for (const frame of frames.splice(0)) {
      act(() => reportClaim(...frame))
    }
  }
  act(() => {
    native = create(createElement(Native))
    page = create(createElement(Page, { toolbar: initialToolbar }))
  })
  const owner = frames.at(-1)?.[1]
  deliver()
  return { Page, frames, deliver, owner, terminal, onKey }
}

it('keeps the native scroll view mounted across toolbar-only updates without releasing ownership', () => {
  const { Page, frames, deliver, owner } = mount()
  const scroll = native!.root.findByType(ScrollView)
  for (const update of [
    { keyboardVisible: true },
    { liveInputEnabled: false },
    { phoneDisplayMode: true },
    { canSend: false },
    { modifiers: { ctrl: 'once', alt: 'off', shift: 'off' } as const }
  ]) {
    const toolbar = { ...initialToolbar, ...update }
    act(() => page!.update(createElement(Page, { toolbar })))
    expect(frames).toEqual([[true, owner, toolbar]])
    deliver()
    expect(native!.root.findByType(ScrollView)).toBe(scroll)
  }
})

it('updates pane ownership without releasing the rail and still releases when covered', () => {
  const { Page, frames, deliver, owner, terminal, onKey } = mount()
  act(() => page!.update(createElement(Page, { toolbar: initialToolbar, focusedTerminal: 'two' })))
  expect(frames.map(([claimed]) => claimed)).toEqual([true])
  const nextOwner = frames.at(-1)?.[1]
  expect(nextOwner).not.toBe(owner)
  terminal.accept('enter', owner)
  expect(onKey).not.toHaveBeenCalled()
  terminal.accept('enter', nextOwner)
  expect(onKey).toHaveBeenCalledExactlyOnceWith('enter')
  deliver()
  act(() =>
    page!.update(
      createElement(Page, { toolbar: initialToolbar, shown: false, focusedTerminal: 'two' })
    )
  )
  expect(frames).toEqual([[false, undefined, undefined]])
  terminal.accept('enter', nextOwner)
  expect(onKey).toHaveBeenCalledTimes(1)
  deliver()
  expect(native!.root.findAllByType(ScrollView)).toHaveLength(0)
})

it.each(['one', 'two'])(
  'keeps committed bridge input while a transition to pane %s is suspended',
  (nextTerminal) => {
    let owner: string | undefined
    const terminal = createBridgeClientTerminalKeys((_claimed, inputOwner) => {
      owner = inputOwner
    })
    const session = { terminalKeyRail: [], terminalKeyInputOwners: true }
    bridge.client.mockReturnValue({
      onTerminalKeyRailUpdate: () => () => {},
      getShellSession: () => session,
      claimTerminalKeyRail: terminal.claim
    })
    const committed = vi.fn()
    const next = vi.fn()
    const pending = new Promise<void>(() => {})
    function Dock({
      callback,
      focusedTerminal = 'one',
      suspend = false
    }: {
      callback: (key: BridgeTerminalKeyId) => void
      focusedTerminal?: string
      suspend?: boolean
    }) {
      useShellTerminalKeyRail(true, callback, focusedTerminal, initialToolbar)
      if (suspend) {
        throw pending
      }
      return null
    }
    act(() => {
      page = create(
        <Suspense fallback={null}>
          <Dock callback={committed} />
        </Suspense>
      )
    })
    const committedOwner = owner
    act(() => {
      startTransition(() =>
        page!.update(
          <Suspense fallback={null}>
            <Dock callback={next} focusedTerminal={nextTerminal} suspend />
          </Suspense>
        )
      )
    })
    expect(owner).toBe(committedOwner)
    act(() => terminal.accept('enter', committedOwner))
    expect({ committed: committed.mock.calls, uncommitted: next.mock.calls }).toEqual({
      committed: [['enter']],
      uncommitted: []
    })
    act(() => {
      page!.update(
        <Suspense fallback={null}>
          <Dock callback={next} focusedTerminal={nextTerminal} />
        </Suspense>
      )
    })
    act(() => terminal.accept('tab', owner))
    expect(committed).toHaveBeenCalledTimes(1)
    expect(next).toHaveBeenCalledExactlyOnceWith('tab')
  }
)
