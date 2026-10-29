import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentLaunchResult } from '../../../src/shared/agent-launch-intent'

vi.mock('react-native', async () => {
  const React = await import('react')
  return {
    Pressable: ({ children, ...props }: { children?: ReactNode }) =>
      React.createElement('Pressable', props, children),
    Text: ({ children, ...props }: { children?: ReactNode }) =>
      React.createElement('Text', props, children),
    View: ({ children, ...props }: { children?: ReactNode }) =>
      React.createElement('View', props, children),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 }
  }
})
const navigation = vi.hoisted(() => ({ navigate: vi.fn() }))
const writeText = vi.hoisted(() => vi.fn(async (_text: string) => {}))
vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ hostId: 'host/1', name: 'My workspace' })
}))
vi.mock('../navigation/route-handoff', () => ({ useRouteHandoff: () => navigation }))
vi.mock('lucide-react-native', () => ({ MessageSquare: () => null, Terminal: () => null }))
vi.mock('../platform/clipboard', () => ({
  useClipboardWriter: () => ({ writeText })
}))

import { AgentLaunchNotice } from './AgentLaunchNotice'
import { AGENT_LAUNCH_UPDATE_REQUIRED_MESSAGE } from '../session/mobile-existing-agent-launch'
import type { MobileAgentLaunchAvailability } from '../session/mobile-agent-launch-availability'
import { WorkspaceExecutionHostContext } from '../navigation/workspace-execution-host'
import { notificationPaneTab } from '../session/notification-pane-tab'

const ERROR_STYLE = { color: 'red' }
const LEAF = '12345678-1234-4123-a123-123456789abc'
const LAUNCH: AgentLaunchResult = {
  outcome: { kind: 'structured', sessionId: 'claude_s1', handle: 'h', tabId: 'chat-1' },
  worktreeId: 'folder::/my workspace',
  receipt: { mode: 'structured', preferred: 'structured', reason: 'user_default', detail: 'd' }
}
const WARNING =
  'Started a structured chat session using saved agent Arguments; the per-launch argument override was ignored.'

describe('AgentLaunchNotice', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    vi.clearAllMocks()
  })

  function mount(props: {
    availability?: MobileAgentLaunchAvailability
    launch?: AgentLaunchResult | null
    error?: string | null
    undeliveredPrompt?: string | null
  }) {
    act(() => {
      renderer = create(
        createElement(
          WorkspaceExecutionHostContext.Provider,
          { value: 'ssh:box' },
          createElement(AgentLaunchNotice, {
            availability: props.availability ?? 'available',
            launch: props.launch ?? null,
            error: props.error ?? null,
            undeliveredPrompt: props.undeliveredPrompt ?? null,
            errorStyle: ERROR_STYLE
          })
        )
      )
    })
  }

  function lines() {
    return (renderer?.root.findAll((node) => String(node.type) === 'Text') ?? []).map((node) =>
      String(node.props.children)
    )
  }

  async function press(label: string) {
    const button = renderer?.root.findAll(
      (node) => String(node.type) === 'Pressable' && node.props.accessibilityLabel === label
    )[0]
    expect(button).toBeDefined()
    await act(async () => button?.props.onPress())
  }

  function destination(): URL {
    expect(navigation.navigate).toHaveBeenCalledOnce()
    return new URL(navigation.navigate.mock.calls[0][0], 'https://orca.test')
  }

  it('preserves host warnings alongside the button that opens the exact chat', async () => {
    mount({ launch: { ...LAUNCH, warning: WARNING } })
    expect(lines()).toEqual([WARNING, 'Open chat'])
    await press('Open chat')
    const route = destination()
    expect(route.pathname).toBe('/h/host%2F1/session/folder%3A%3A%2Fmy%20workspace')
    expect(route.searchParams.get('name')).toBe('My workspace')
    expect(route.searchParams.get('executionHost')).toBe('ssh:box')
    expect(
      notificationPaneTab(
        [
          {
            id: 'chat-1',
            type: 'agent-session',
            sessionId: 'claude_s1',
            agent: 'claude',
            title: 'Chat',
            isActive: false
          }
        ],
        route.searchParams.get('paneKey') ?? ''
      )?.id
    ).toBe('chat-1')
  })

  it('opens a chat from older hosts that omit the host tab id', async () => {
    mount({
      launch: { ...LAUNCH, outcome: { kind: 'structured', sessionId: 'claude_s1', handle: 'h' } }
    })
    await press('Open chat')
    expect(
      notificationPaneTab(
        [
          {
            id: 'legacy-chat',
            type: 'agent-session',
            sessionId: 'claude_s1',
            agent: 'claude',
            title: 'Chat',
            isActive: false
          }
        ],
        destination().searchParams.get('paneKey') ?? ''
      )?.id
    ).toBe('legacy-chat')
  })

  it('labels and selects a terminal launch using its pane identity', async () => {
    mount({
      launch: {
        ...LAUNCH,
        outcome: { kind: 'terminal', handle: 'term-1', paneKey: `tab-1:${LEAF}` }
      }
    })
    expect(lines()).toEqual(['Open terminal'])
    await press('Open terminal')
    expect(destination().searchParams.get('paneKey')).toBe(`tab-1:${LEAF}`)
  })

  it('opens the workspace when an older terminal host supplies no pane identity', async () => {
    mount({ launch: { ...LAUNCH, outcome: { kind: 'terminal', handle: 'term-1' } } })
    expect(lines()).toEqual(['Open workspace'])
    await press('Open workspace')
    expect(destination().searchParams.has('paneKey')).toBe(false)
  })

  it('keeps prompt recovery beside the navigation button when delivery fails', async () => {
    mount({
      launch: { ...LAUNCH, warning: WARNING },
      error: "The agent started, but the prompt wasn't sent.",
      undeliveredPrompt: 'Fix the failing checks'
    })
    expect(lines()).toEqual([
      "The agent started, but the prompt wasn't sent.",
      WARNING,
      'Open chat',
      'Copy prompt'
    ])
    await press('Copy prompt')
    expect(writeText).toHaveBeenCalledWith('Fix the failing checks')
    expect(lines()).toContain('Copied')
  })

  it('keeps an unavailable host actionable without showing launch diagnostics', () => {
    mount({ availability: 'update-required' })
    expect(lines()).toEqual([AGENT_LAUNCH_UPDATE_REQUIRED_MESSAGE])
  })

  it('renders nothing before a launch', () => {
    mount({})
    expect(lines()).toEqual([])
  })
})
