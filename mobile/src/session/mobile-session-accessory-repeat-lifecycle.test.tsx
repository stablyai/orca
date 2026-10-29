import { createElement, useLayoutEffect, useRef } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppStateStatus } from 'react-native'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState, RpcResponse } from '../transport/types'
import { FakeSession } from '../transport/mobile-endpoint-supervisor-test-fakes'
import type { TerminalLiveAccessoryInputCommitResult } from '../terminal/use-terminal-live-accessory-input-commit'
import { useMobileSessionAccessorySelection } from './use-mobile-session-accessory-selection'
import { useMobileSessionTerminalSendActions } from './use-mobile-session-terminal-send-actions'

const lifecycle = vi.hoisted(() => ({
  focused: true,
  listeners: new Set<(state: AppStateStatus) => void>()
}))
vi.mock('expo-router', async () => {
  const { useEffect } = await import('react')
  return {
    useFocusEffect: (effect: () => () => void) =>
      useEffect(() => (lifecycle.focused ? effect() : undefined), [effect, lifecycle.focused])
  }
})
vi.mock('react-native', () => ({
  Keyboard: { dismiss: vi.fn() },
  Platform: { OS: 'ios' },
  AppState: {
    currentState: 'active',
    addEventListener: (_event: string, listener: (state: AppStateStatus) => void) => {
      lifecycle.listeners.add(listener)
      return { remove: () => lifecycle.listeners.delete(listener) }
    }
  }
}))
vi.mock('../platform/haptics', () => ({
  triggerSelection: vi.fn(),
  triggerSuccess: vi.fn(),
  triggerError: vi.fn(),
  triggerEdgeBump: vi.fn()
}))
vi.mock('../platform/clipboard', () => ({
  useClipboardWriter: () => ({ writeText: vi.fn() }),
  useClipboardReader: () => ({ contents: vi.fn() })
}))
vi.mock('../terminal/terminal-copy-gutter-preference', () => ({
  useTerminalCopyTrimsGutter: () => ({ current: true })
}))

const input = { bytes: '\x7f', localEdit: 'backspace' } as const
const accepted: RpcResponse = { id: 'input', ok: true, result: { send: { accepted: true } } }

describe('mounted accessory-repeat delivery lifecycle', () => {
  let tree: ReactTestRenderer | null = null
  beforeEach(() => {
    vi.useFakeTimers()
    lifecycle.focused = true
  })
  afterEach(() => {
    act(() => tree?.unmount())
    tree = null
    vi.useRealTimers()
    lifecycle.listeners.clear()
  })

  async function mount() {
    let generation = 1
    const client = Object.assign(new FakeSession('connected'), { getGeneration: () => generation })
    client.sendRequest.mockResolvedValue(accepted)
    const preflight = vi.fn<() => Promise<TerminalLiveAccessoryInputCommitResult>>(async () => ({
      kind: 'allow-raw'
    }))
    let api: ReturnType<typeof useMobileSessionAccessorySelection> | null = null
    type Props = {
      client: RpcClient
      handle: string
      state: ConnectionState
      preflight?: typeof preflight
    }
    function Harness(props: Props) {
      const clientRef = useRef(props.client)
      const activeHandleRef = useRef<string | null>(props.handle)
      const connStateRef = useRef(props.state)
      useLayoutEffect(() => {
        clientRef.current = props.client
        activeHandleRef.current = props.handle
        connStateRef.current = props.state
      }, [props.client, props.handle, props.state])
      const scope = {
        client: props.client,
        clientRef,
        activeHandle: props.handle,
        activeHandleRef,
        connState: props.state,
        connStateRef,
        canSend: true,
        activeSessionTabTypeRef: { current: 'terminal' },
        sendLiveTerminalInputRef: { current: async () => false },
        sessionTabActionSheetKeyboardHideSubRef: { current: null },
        deviceTokenRef: { current: null },
        ptyModesRef: { current: new Map() },
        commandInputRef: { current: null },
        liveInputRef: { current: null },
        handleLiveInputAccessoryBytes: props.preflight ?? preflight,
        worktreeId: 'workspace',
        clearTerminalCache: vi.fn(),
        clearToastHideTimer: vi.fn(),
        clearDelayedActionTimers: vi.fn(),
        clearPendingLiveInputCommit: vi.fn(),
        toastSeqRef: { current: 0 },
        liveInputFocusTimerRef: { current: null },
        sessionTabActionSheetRequestSeqRef: { current: 0 },
        clearSessionTabActionSheetKeyboardListener: vi.fn()
      }
      const send = useMobileSessionTerminalSendActions(
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Only accessory delivery and field-binding initialization run; all dependencies they read are supplied.
        scope as unknown as Parameters<typeof useMobileSessionTerminalSendActions>[0]
      )
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Repeat lifecycle reads the supplied route identity, transport refs, and actual accessory send callback.
      api = useMobileSessionAccessorySelection({ ...scope, ...send } as unknown as Parameters<
        typeof useMobileSessionAccessorySelection
      >[0])
      return null
    }
    let props: Props = { client, handle: 'a', state: 'connected' }
    await act(async () => {
      tree = create(createElement(Harness, props))
    })
    return {
      client,
      preflight,
      current() {
        if (!api) {
          throw new Error('Accessory hook did not render')
        }
        return api
      },
      bumpGeneration() {
        generation += 1
      },
      async update(change: Partial<Props>) {
        props = { ...props, ...change }
        await act(async () => tree?.update(createElement(Harness, props)))
      },
      writes() {
        return client.sendRequest.mock.calls.filter(([method]) => method === 'terminal.send')
      },
      async advance(ms: number) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(ms)
        })
      }
    }
  }

  it.each([
    'terminal',
    'client',
    'disconnect',
    'generation',
    'blur',
    'background',
    'unmount'
  ] as const)('retires a hold across %s and does not restart it on return', async (cutover) => {
    const view = await mount()
    act(() => view.current().startAccessoryRepeat(input))
    await view.advance(445)
    expect(view.writes().length).toBeGreaterThan(0)
    view.client.sendRequest.mockClear()
    if (cutover === 'terminal') {
      await view.update({ handle: 'b' })
    }
    if (cutover === 'client') {
      await view.update({ client: new FakeSession('connected') })
    }
    if (cutover === 'disconnect') {
      await view.update({ state: 'reconnecting' })
    }
    if (cutover === 'generation') {
      view.bumpGeneration()
    }
    if (cutover === 'blur') {
      lifecycle.focused = false
      await view.update({})
    }
    if (cutover === 'background') {
      act(() => lifecycle.listeners.forEach((listener) => listener('background')))
    }
    if (cutover === 'unmount') {
      act(() => tree?.unmount())
      tree = null
    }
    await view.advance(500)
    expect(view.writes()).toHaveLength(0)
    if (cutover !== 'unmount') {
      lifecycle.focused = true
      act(() => lifecycle.listeners.forEach((listener) => listener('active')))
      await view.update({ client: view.client, handle: 'a', state: 'connected' })
      await view.advance(500)
      expect(view.writes()).toHaveLength(0)
    }
  })

  it.each(['terminal', 'blur', 'background'] as const)(
    'keeps pending preflight retired after %s returns to the same owner',
    async (cutover) => {
      const view = await mount()
      let finishPreflight: (result: TerminalLiveAccessoryInputCommitResult) => void = () => {}
      view.preflight.mockImplementation(
        () =>
          new Promise((resolve) => {
            finishPreflight = resolve
          })
      )
      act(() => view.current().startAccessoryRepeat(input))
      if (cutover === 'terminal') {
        await view.update({ handle: 'b' })
        await view.update({ handle: 'a' })
      } else if (cutover === 'blur') {
        lifecycle.focused = false
        await view.update({})
        lifecycle.focused = true
        await view.update({})
      } else {
        act(() => lifecycle.listeners.forEach((listener) => listener('background')))
        act(() => lifecycle.listeners.forEach((listener) => listener('active')))
      }
      await act(async () => finishPreflight({ kind: 'allow-raw' }))
      await view.advance(500)
      expect(view.writes()).toHaveLength(0)
    }
  )

  it.each([
    ['handled', 3],
    ['suppress-raw', 1]
  ] as const)(
    'follows the live editor’s %s result when repeating a local edit',
    async (kind, expectedEdits) => {
      const view = await mount()
      view.preflight.mockResolvedValue({ kind })
      act(() => view.current().startAccessoryRepeat(input))
      await view.advance(445)
      expect(view.preflight).toHaveBeenCalledTimes(expectedEdits)
      expect(view.writes()).toHaveLength(0)
    }
  )

  it('repeats through the latest live editor when live input turns on mid-hold', async () => {
    const view = await mount()
    act(() => view.current().startAccessoryRepeat(input))
    await view.advance(445)
    expect(view.writes().length).toBeGreaterThan(0)
    const liveEditor = vi.fn<() => Promise<TerminalLiveAccessoryInputCommitResult>>(async () => ({
      kind: 'handled'
    }))
    await view.update({ preflight: liveEditor })
    view.client.sendRequest.mockClear()
    await view.advance(200)
    expect(liveEditor).toHaveBeenCalled()
    expect(view.writes()).toHaveLength(0)
  })

  it('waits for each host acknowledgment and drops pending preflight after the terminal changes', async () => {
    const view = await mount()
    let answerSend: (reply: RpcResponse) => void = () => {}
    view.client.sendRequest.mockImplementation(
      () =>
        new Promise<RpcResponse>((resolve) => {
          answerSend = resolve
        })
    )
    act(() => view.current().startAccessoryRepeat(input))
    await view.advance(1000)
    expect(view.writes()).toHaveLength(1)
    act(() => view.current().stopAccessoryRepeat())
    await act(async () => answerSend(accepted))
    await view.advance(500)
    expect(view.writes()).toHaveLength(1)
    view.client.sendRequest.mockClear()
    let finishPreflight: (result: TerminalLiveAccessoryInputCommitResult) => void = () => {}
    view.preflight.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishPreflight = resolve
        })
    )
    act(() => view.current().startAccessoryRepeat(input))
    await view.update({ handle: 'b' })
    await act(async () => finishPreflight({ kind: 'allow-raw' }))
    expect(view.writes()).toHaveLength(0)
  })

  it.each(['refusal', 'disconnect'] as const)(
    'stops on %s until a new press instead of retrying held input',
    async (failure) => {
      const view = await mount()
      if (failure === 'refusal') {
        view.client.sendRequest.mockResolvedValue({
          id: 'input',
          ok: false,
          error: { code: 'refused', message: 'Input not accepted' }
        })
      } else {
        view.client.sendRequest.mockRejectedValue(new Error('Disconnected'))
      }
      act(() => view.current().startAccessoryRepeat(input))
      await view.advance(1000)
      expect(view.writes()).toHaveLength(1)
      view.client.sendRequest.mockResolvedValue(accepted)
      await view.advance(1000)
      expect(view.writes()).toHaveLength(1)
      act(() => view.current().startAccessoryRepeat(input))
      await view.advance(445)
      expect(view.writes().length).toBeGreaterThan(2)
      expect(
        view
          .writes()
          .every(
            ([, params]) =>
              typeof params === 'object' &&
              params !== null &&
              'terminal' in params &&
              params.terminal === 'a'
          )
      ).toBe(true)
    }
  )
})
