import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'

const hosts = vi.hoisted(() => {
  const make = (name: string) => {
    const Host = (props: { children?: ReactNode; accessibilityLabel?: string }): ReactNode =>
      props.children ?? null
    Host.displayName = name
    return Host
  }
  return { View: make('View'), Text: make('Text') }
})

vi.mock('react-native', () => ({
  View: hosts.View,
  Text: hosts.Text,
  StyleSheet: { create: <T,>(styles: T) => styles },
  Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options.ios },
  Appearance: { getColorScheme: () => 'light', addChangeListener: () => ({ remove: () => {} }) }
}))
// The sheet's chrome is not under test: render only its title the way the real header does.
vi.mock('../../components/sheets/ActionSheetModal', () => ({
  ActionSheetModal: (props: { title?: ReactNode; titleAccessibilityLabel?: string }) =>
    createElement(hosts.Text, { accessibilityLabel: props.titleAccessibilityLabel }, props.title)
}))
vi.mock('../native-chat/mobile-native-chat-cli-fork', () => ({
  getMobileNativeChatCliForkActions: () => []
}))
vi.mock('./mobile-worker-auto-close', () => ({
  useMobileAllowAutoCloseActions: () => [],
  workerSubjectOf: () => undefined
}))

const { MobileAgentSessionTabActionSheet } = await import('./MobileAgentSessionTabActionSheet')

let renderer: ReactTestRenderer | undefined
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = undefined
})

function titleOf(forked: boolean): { text: string; label: string | undefined } {
  const tab = {
    type: 'agent-session' as const,
    id: 'tab',
    title: 'Annotate capabilities',
    sessionId: 'chat',
    agent: 'claude' as const,
    isActive: true,
    ...(forked ? { forked: true as const } : {})
  }
  const controller = {
    agentSessionActionTarget: tab,
    setAgentSessionActionTarget: () => {},
    closeWithBulkActions: () => [],
    client: null
  }
  act(() => {
    renderer = create(
      createElement(MobileAgentSessionTabActionSheet, {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the sheet reads only these controller members.
        controller: controller as never,
        workspaceOnPairedHost: true
      })
    )
  })
  const header = renderer!.root.findAllByType(hosts.Text)[0]!
  const text = (node: unknown): string =>
    typeof node === 'string'
      ? node
      : Array.isArray(node)
        ? node.map(text).join('')
        : node && typeof node === 'object' && 'children' in node
          ? text(node.children)
          : ''
  return { text: text(renderer!.toJSON()), label: header.props.accessibilityLabel }
}

it("titles a fork tab's sheet with its fork mark", () => {
  expect(titleOf(true)).toEqual({
    text: 'Fork · Annotate capabilities',
    label: 'Fork: Annotate capabilities'
  })
})

it("keeps an original chat tab's sheet title plain", () => {
  expect(titleOf(false)).toEqual({ text: 'Annotate capabilities', label: undefined })
})
