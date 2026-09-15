import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../src/shared/agent-session-journal-types'
import { MobileNativeChatPermission } from './MobileNativeChatPermission'
import {
  pendingStructuredApproval,
  projectStructuredPermission
} from './mobile-structured-agent-prompts'

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View'
}))

vi.mock('lucide-react-native', () => ({ ShieldQuestion: 'ShieldQuestion', X: 'X' }))
vi.mock('../components/MobileMarkdown', () => ({ MobileMarkdown: 'MobileMarkdown' }))

describe('MobileNativeChatPermission', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it('accepts only one response when two presses land in the same render batch', async () => {
    let resolveResponse: (accepted: boolean) => void = () => {}
    const response = new Promise<boolean>((resolve) => (resolveResponse = resolve))
    const onRespond = vi.fn(() => response)
    await act(async () => {
      renderer = create(
        createElement(MobileNativeChatPermission, {
          permission: { title: 'Approve?', options: [{ label: 'Allow', send: '1' }] },
          onRespond
        })
      )
    })
    const button = renderer.root.findByType('Pressable')

    act(() => {
      button.props.onPress()
      button.props.onPress()
    })

    expect(onRespond).toHaveBeenCalledOnce()
    await act(async () => resolveResponse(true))
  })

  it('passes the rendered prompt identity to cancel', async () => {
    const onCancel = vi.fn(async () => true)
    await act(async () => {
      renderer = create(
        createElement(MobileNativeChatPermission, {
          permission: {
            title: 'Approve?',
            prompt: { itemId: 'approval-1', expectedRevision: 4 },
            options: [{ label: 'Allow', send: '1' }]
          },
          onRespond: vi.fn(async () => true),
          onCancel
        })
      )
    })
    const cancel = renderer.root.findByProps({ accessibilityLabel: 'Cancel' })
    await act(async () => cancel.props.onPress())
    expect(onCancel).toHaveBeenCalledWith({ itemId: 'approval-1', expectedRevision: 4 })
  })

  it('keeps a typed plan in the approval flow and renders bounded markdown', async () => {
    const item: AgentJournalRenderItem = {
      itemId: 'plan-approval',
      revision: 1,
      sequence: 1,
      observedAt: 1,
      body: {
        kind: 'approval',
        title: 'Claude wants to present a plan',
        subject: {
          kind: 'plan',
          text: '# Mobile plan\n\n- Render markdown',
          filePath: '/repo/plan.md'
        },
        detail: null,
        options: [
          { id: 'allow', label: 'Approve plan' },
          { id: 'deny', label: 'Keep planning' }
        ],
        resolution: {
          state: 'pending',
          selectedOptionId: null,
          resolvedBy: null,
          resolvedAt: null
        }
      }
    }
    expect(pendingStructuredApproval(item)).toBe(true)
    if (!pendingStructuredApproval(item)) {
      throw new Error('expected a pending approval')
    }
    const permission = projectStructuredPermission(item)
    if (!permission) {
      throw new Error('expected a projected permission')
    }

    await act(async () => {
      renderer = create(
        createElement(MobileNativeChatPermission, {
          permission,
          onRespond: async () => true
        })
      )
    })

    expect(permission.subject?.kind).toBe('plan')
    expect(renderer.root.findByType('MobileMarkdown').props.content).toBe(
      '# Mobile plan\n\n- Render markdown'
    )
    expect(renderer.root.findByType('ScrollView').props.style).toMatchObject({ maxHeight: 240 })
    expect(renderer.root.findAllByType('Pressable')).toHaveLength(2)
  })
})
