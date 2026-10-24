import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
const probe = vi.hoisted(() => ({
  changeApp: (_state: string) => {},
  leaveRoute: () => {}
}))
vi.mock('react-native', () => ({
  View: 'View',
  StyleSheet: { create: (value: unknown) => value },
  AppState: {
    currentState: 'active',
    addEventListener: (_name: string, callback: (state: string) => void) => {
      probe.changeApp = callback
      return { remove: vi.fn() }
    }
  }
}))
vi.mock('expo-router', async () => {
  const { useEffect } = await import('react')
  return {
    useFocusEffect: (effect: () => () => void) =>
      useEffect(() => {
        const leave = effect()
        probe.leaveRoute = leave
        return leave
      }, [effect])
  }
})
vi.mock('../terminal/TerminalWebView', () => ({ TerminalWebView: 'TerminalWebView' }))
import { TerminalPaneView } from './TerminalPaneView'

it('retains the terminal but disables interaction on tab hiding, app backgrounding and route blur', async () => {
  const props: Parameters<typeof TerminalPaneView>[0] = {
    handle: 'terminal',
    active: true,
    keyboardLift: 0,
    textScale: 1,
    onRef: vi.fn(),
    onWebReady: vi.fn(),
    onSelectionMode: vi.fn(),
    onSelectionCopy: vi.fn(),
    onSelectionEvicted: vi.fn(),
    onModesChanged: vi.fn(),
    onKeyboardAvoidanceMetrics: vi.fn(),
    onHaptic: vi.fn(),
    onTerminalInput: vi.fn(),
    onTerminalQueryReply: vi.fn(),
    onTerminalTap: vi.fn(),
    onFileTap: vi.fn(),
    onOpenUrl: vi.fn(),
    onTextScaleChange: vi.fn(),
    onCellBoxChange: vi.fn()
  }
  let renderer!: ReturnType<typeof create>
  await act(async () => {
    renderer = create(createElement(TerminalPaneView, props))
  })
  const terminal = () => renderer.root.find((node) => String(node.type) === 'TerminalWebView')
  expect(terminal().props.interactionActive).toBe(true)
  await act(async () => probe.changeApp('background'))
  expect(terminal().props.interactionActive).toBe(false)
  await act(async () => probe.changeApp('active'))
  expect(terminal().props.interactionActive).toBe(true)
  await act(async () =>
    renderer.update(createElement(TerminalPaneView, { ...props, active: false }))
  )
  expect(terminal().props.interactionActive).toBe(false)
  await act(async () => renderer.update(createElement(TerminalPaneView, props)))
  expect(terminal().props.interactionActive).toBe(true)
  await act(async () => probe.leaveRoute())
  expect(terminal().props.interactionActive).toBe(false)
  expect(renderer.root.findAll((node) => String(node.type) === 'TerminalWebView')).toHaveLength(1)
  await act(async () => renderer.unmount())
})
