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

import type { MobileAgentLaunchAvailability } from '../session/agent-launch/mobile-agent-launch-availability'

const ERROR_STYLE = { color: 'red' }

describe('AgentLaunchNotice', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  function lines(props: {
    availability?: MobileAgentLaunchAvailability
    success?: string | null
    error?: string | null
    warning?: string | null
  }): { text: string; isError: boolean }[] {
    act(() => {
      renderer = create(
        createElement(AgentLaunchNotice, {
          availability: props.availability ?? 'available',
          success: props.success ?? null,
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

  it('renders nothing with nothing to say', () => {
    expect(lines({})).toEqual([])
  })
})
