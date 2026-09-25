import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-native', async () => {
  const React = await import('react')
  return {
    Pressable: ({ children, ...props }: { children?: ReactNode }) =>
      React.createElement('Pressable', props, children),
    Text: ({ children, ...props }: { children?: ReactNode }) =>
      React.createElement('Text', props, children),
    View: ({ children, ...props }: { children?: ReactNode }) =>
      React.createElement('View', props, children),
    StyleSheet: { create: (styles: unknown) => styles }
  }
})
vi.mock('../platform/clipboard', () => ({
  useClipboardWriter: () => ({ writeText: async () => {} })
}))

import { AgentLaunchNotice } from './AgentLaunchNotice'
import { AGENT_LAUNCH_UPDATE_REQUIRED_MESSAGE } from '../session/mobile-existing-agent-launch'
import type { MobileAgentLaunchAvailability } from '../session/mobile-agent-launch-availability'

const ERROR_STYLE = { color: 'red' }

describe('AgentLaunchNotice', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  function lines(props: {
    availability?: MobileAgentLaunchAvailability
    error?: string | null
    warning?: string | null
  }): { text: string; isError: boolean }[] {
    act(() => {
      renderer = create(
        createElement(AgentLaunchNotice, {
          availability: props.availability ?? 'available',
          error: props.error ?? null,
          warning: props.warning ?? null,
          undeliveredPrompt: null,
          errorStyle: ERROR_STYLE
        })
      )
    })
    return (renderer?.root.findAll((node) => String(node.type) === 'Text') ?? []).map((node) => ({
      text: String(node.props.children),
      isError: node.props.style === ERROR_STYLE
    }))
  }

  it('shows the host warning on a launch that went ahead as secondary text, not an error', () => {
    expect(lines({ warning: 'the requested arguments were ignored.' })).toEqual([
      { text: 'the requested arguments were ignored.', isError: false }
    ])
  })

  it('keeps a real failure in the error style beside a warning', () => {
    expect(
      lines({ error: "The agent started, but the prompt wasn't sent.", warning: 'w' })
    ).toEqual([
      { text: "The agent started, but the prompt wasn't sent.", isError: true },
      { text: 'w', isError: false }
    ])
  })

  it('drops a stale warning while the host cannot take a launch', () => {
    expect(lines({ availability: 'update-required', warning: 'w' })).toEqual([
      { text: AGENT_LAUNCH_UPDATE_REQUIRED_MESSAGE, isError: true }
    ])
  })

  it('renders nothing with nothing to say', () => {
    expect(lines({})).toEqual([])
  })
})
