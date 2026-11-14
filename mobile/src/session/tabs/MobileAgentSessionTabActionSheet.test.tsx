import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'

const hosts = vi.hoisted(() => {
  const make = (name: string) => {
    const Host = (props: {
      children?: ReactNode
      accessibilityLabel?: string
      name?: string
    }): ReactNode => props.children ?? null
    Host.displayName = name
    return Host
  }
  return { Title: make('Title'), MarkedName: make('MarkedName') }
})

vi.mock('react-native', () => ({}))
// The sheet's chrome is not under test: keep only the title and its spoken label.
vi.mock('../../components/sheets/ActionSheetModal', () => ({
  ActionSheetModal: (props: { title?: ReactNode; titleAccessibilityLabel?: string }) =>
    createElement(hosts.Title, { accessibilityLabel: props.titleAccessibilityLabel }, props.title)
}))
vi.mock('../fork/MobileForkMarkedName', () => ({
  MobileForkMarkedName: (props: { name: string }) => createElement(hosts.MarkedName, props)
}))
vi.mock('../fork/mobile-fork-marked-name', () => ({
  mobileForkAccessibleName: (name: string) => `fork-label(${name})`
}))
vi.mock('../../i18n/use-mobile-translation', () => ({
  useMobileTranslation: () => (_key: string, fallback: string) => fallback
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

function renderSheet(forked: boolean): ReactTestRenderer {
  const tab = {
    type: 'agent-session' as const,
    id: 'tab',
    title: 'Plan',
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
  return renderer!
}

it("titles a fork tab's sheet with the fork-marked name and its spoken label", () => {
  const sheet = renderSheet(true)
  const title = sheet.root.findByType(hosts.Title)
  expect(sheet.root.findByType(hosts.MarkedName).props.name).toBe('Plan')
  expect(title.props.accessibilityLabel).toBe('fork-label(Plan)')
})

it("titles an original chat tab's sheet with its plain name", () => {
  const sheet = renderSheet(false)
  const title = sheet.root.findByType(hosts.Title)
  expect(sheet.root.findAllByType(hosts.MarkedName)).toHaveLength(0)
  expect(title.props.children).toBe('Plan')
  expect(title.props.accessibilityLabel).toBeUndefined()
})
