import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AutomationRunMessage } from '../../../../../src/shared/automations/automation-run-message'

const opened = vi.hoisted((): string[] => [])

vi.mock('react-native', async () => {
  const React = await import('react')
  const Text = ({ children, ...props }: { children?: ReactNode }): ReactNode =>
    React.createElement('Text', props, children)
  return {
    Platform: { OS: 'ios' },
    Pressable: 'Pressable',
    Text,
    View: ({ children, ...props }: { children?: ReactNode }) =>
      React.createElement('View', props, children),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Linking: { openURL: vi.fn() }
  }
})
vi.mock('lucide-react-native', () => ({
  ArrowUpRight: 'ArrowUpRight',
  CalendarClock: 'CalendarClock',
  Check: 'Check',
  ChevronRight: 'ChevronRight',
  Hourglass: 'Hourglass',
  Play: 'Play',
  Webhook: 'Webhook',
  Zap: 'Zap',
  Clock: 'Clock',
  X: 'X'
}))
vi.mock('../../../components/markdown/MobileMarkdown', () => ({ MobileMarkdown: 'MobileMarkdown' }))
vi.mock('../../../components/code-presentation/MobileSourceCopyButton', () => ({
  MobileSourceCopyButton: 'CopyButton'
}))
vi.mock('../../../hooks/use-now', () => ({
  useNow: () => 70_000,
  useSharedNowSnapshot: <T,>(_intervalMs: number, select: (now: number) => T) => select(70_000)
}))
vi.mock('../../../platform/external-links/external-link', () => ({
  openExternalLink: (url: string) => opened.push(url)
}))

import { MobileNativeChatAutomationRunRow } from './MobileNativeChatAutomationRunRow'

const PROMPT = 'Line one\nLine two\nLine three\nLine four\nLine five\nLine six'

const RUN: AutomationRunMessage = {
  runId: 'run-1',
  automation: {
    id: 'auto-1',
    name: 'Answer PR questions',
    enabled: true,
    nextRunAt: 0,
    updatedAt: 1,
    dtstart: 1,
    rrule: 'FREQ=DAILY',
    workspaceId: 'folder:bot'
  },
  trigger: 'event',
  event: {
    source: 'github',
    event: 'comment',
    place: 'stablyai/orca#41812',
    occurredAt: 1,
    url: 'https://github.com/stablyai/orca/pull/41812#issuecomment-1',
    actor: 'nora',
    text: 'does it handle quoted paths?',
    textShortened: true,
    asker: 'member'
  },
  instructionsLength: PROMPT.length
}

function textOf(node: ReactTestInstance): string {
  return node.children.map((child) => (typeof child === 'string' ? child : textOf(child))).join('')
}

describe('mobile automation run row', () => {
  let tree: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => tree?.unmount())
    tree = null
    opened.length = 0
  })

  function openRow(run: AutomationRunMessage = RUN): ReactTestRenderer {
    act(() => {
      tree = create(
        createElement(MobileNativeChatAutomationRunRow, {
          messageId: run.runId,
          run,
          state: 'ran',
          text: `${PROMPT}\n\n${run.event?.text ?? ''}`,
          timestamp: 2,
          fontScale: 1
        })
      )
    })
    act(() => {
      pressable(tree!, (node) => node.props.accessibilityState?.expanded === false)
    })
    return tree!
  }

  function pressable(
    root: ReactTestRenderer,
    match: (node: ReactTestInstance) => boolean
  ): ReactTestInstance {
    const node = root.root.findAll((n) => String(n.type) === 'Pressable' && match(n))[0]!
    node.props.onPress()
    return node
  }

  const texts = (root: ReactTestRenderer): string[] =>
    root.root.findAll((node) => String(node.type) === 'Text').map(textOf)
  const markdown = (root: ReactTestRenderer): unknown[] =>
    root.root.findAll((node) => String(node.type) === 'MobileMarkdown').map((n) => n.props.content)

  it('expands long instructions and opens only a secure event source', () => {
    const row = openRow()
    const clamped = row.root.findAll(
      (node) => String(node.type) === 'Text' && node.props.numberOfLines === 4
    )
    expect(clamped.map(textOf)).toEqual([PROMPT])
    expect(markdown(row)).toEqual([])
    const measure = row.root.findAll(
      (node) => String(node.type) === 'Text' && node.props.onLayout !== undefined
    )[0]!
    expect(texts(row)).not.toContain('Show all')
    // Taller than four 25pt lines of chat prose.
    act(() => measure.props.onLayout({ nativeEvent: { layout: { height: 120 } } }))
    act(() => {
      pressable(row, (node) => textOf(node) === 'Show all')
    })
    expect(markdown(row)).toEqual([PROMPT])
    expect(texts(row)).toContain('Show less')

    act(() => {
      pressable(row, (node) => node.props.accessibilityRole === 'link')
    })
    expect(opened).toEqual(['https://github.com/stablyai/orca/pull/41812#issuecomment-1'])
    act(() => tree?.unmount())
    const plain = openRow({ ...RUN, event: { ...RUN.event!, url: 'http://example.com/a' } })
    expect(plain.root.findAll((node) => node.props.accessibilityRole === 'link')).toEqual([])
  })
})
