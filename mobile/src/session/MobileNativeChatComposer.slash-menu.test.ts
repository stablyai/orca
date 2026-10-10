import { createElement, type ComponentProps } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionConversationCommand } from '../../../src/shared/agent-session-conversation-command'
import type { AgentSessionSlashCommand } from '../../../src/shared/agent-session-wire'
import {
  nativeChatComposerCatalog,
  type NativeChatStructuredCatalogInputs
} from '../../../src/shared/native-chat-composer-catalog'
import { MobileNativeChatComposer } from './MobileNativeChatComposer'
import { mobileNativeChatSlashMenu } from './mobile-native-chat-slash-menu'
import { getMobileNativeChatCommands } from './mobile-native-chat-send-classification'

vi.mock('react-native', async () => ({
  ActivityIndicator: 'ActivityIndicator',
  Image: 'Image',
  Keyboard: { dismiss: vi.fn() },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  SectionList: (await import('../test-support/section-list-test-double')).SectionListTestDouble,
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View'
}))

vi.mock('lucide-react-native', () => ({
  ArrowUp: 'ArrowUp',
  ImagePlus: 'ImagePlus',
  Mic: 'Mic',
  Square: 'Square',
  X: 'X'
}))

// The session-option pickers reach a drawer that imports untransformable native modules.
vi.mock('../components/BottomDrawer', () => ({ BottomDrawer: () => null }))

// Pass-through spies, so a test can count how often the catalog and rows are rebuilt.
vi.mock('./mobile-native-chat-slash-menu', async (importOriginal) => {
  const actual: { mobileNativeChatSlashMenu: (args: never) => unknown } = await importOriginal()
  return { mobileNativeChatSlashMenu: vi.fn(actual.mobileNativeChatSlashMenu) }
})
vi.mock('../../../src/shared/native-chat-composer-catalog', async (importOriginal) => {
  const actual: { nativeChatComposerCatalog: (...args: never[]) => unknown } =
    await importOriginal()
  return { nativeChatComposerCatalog: vi.fn(actual.nativeChatComposerCatalog) }
})

const REPORT: AgentSessionSlashCommand[] = [
  { name: 'review', kind: 'command', description: 'Review a pull request', argumentHint: '<pr>' },
  { name: 'triage', kind: 'skill', description: 'Sort incoming issues' }
]

const CONVERSATION_COMMANDS: AgentSessionConversationCommand[] = ['clear', 'compact']

function catalog(
  sessionCommands: AgentSessionSlashCommand[] | undefined
): NativeChatStructuredCatalogInputs {
  return { sessionCommands, conversationCommands: CONVERSATION_COMMANDS }
}

const REPORTED = catalog(REPORT)

type ComposerProps = ComponentProps<typeof MobileNativeChatComposer>

describe('MobileNativeChatComposer `/` menu', () => {
  let renderer: ReactTestRenderer | null = null
  const onChangeText = vi.fn()
  const onSend = vi.fn().mockResolvedValue(true)
  const generation = () => 0

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    vi.clearAllMocks()
  })

  function props(overrides: Partial<ComposerProps>): ComposerProps {
    return {
      value: '/',
      onChangeText,
      onSend,
      sendSurfaceId: 'tab-a',
      getSendCompletionGeneration: generation,
      getComposerEditGeneration: generation,
      agent: 'claude',
      slashCatalog: catalog(undefined),
      ...overrides
    }
  }

  async function open(overrides: Partial<ComposerProps> = {}): Promise<void> {
    const next = props(overrides)
    await act(async () => {
      renderer = create(createElement(MobileNativeChatComposer, next))
    })
    const input = renderer!.root.find((node) => String(node.type) === 'TextInput')
    await act(async () =>
      input.props.onSelectionChange({ nativeEvent: { selection: { end: next.value.length } } })
    )
  }

  function texts(): unknown[] {
    return renderer!.root
      .findAll((node) => String(node.type) === 'Text')
      .map((node): unknown => node.props.children)
  }

  function row(token: string): ReactTestInstance {
    return renderer!.root.find(
      (node) =>
        String(node.type) === 'Pressable' &&
        node.findAll((child) => String(child.type) === 'Text' && child.props.children === token)
          .length > 0
    )
  }

  function sections(): unknown {
    return renderer!.root.find((node) => String(node.type) === 'SectionList').props.sections
  }

  it('lists reported commands and skills under their headings with hint and description', async () => {
    await open({ slashCatalog: REPORTED })
    expect(texts()).toEqual([
      'Commands',
      '/review',
      '<pr>',
      'Review a pull request',
      'Skills',
      '/triage',
      'Sort incoming issues'
    ])
  })

  it('inserts the picked skill and command tokens, ready for arguments', async () => {
    await open({ slashCatalog: REPORTED })
    await act(async () => row('/triage').props.onPress())
    expect(onChangeText).toHaveBeenLastCalledWith('/triage ')
    await act(async () => row('/review').props.onPress())
    expect(onChangeText).toHaveBeenLastCalledWith('/review ')
  })

  it('marks the headings for screen readers', async () => {
    await open({ slashCatalog: REPORTED })
    const headings = renderer!.root.findAll(
      (node) => String(node.type) === 'Text' && node.props.accessibilityRole === 'header'
    )
    expect(headings.map((node) => node.props.children)).toEqual(['Commands', 'Skills'])
  })

  it('drops the headings when the session reports no skills', async () => {
    await open({ slashCatalog: catalog([REPORT[0]!]) })
    expect(texts()).toEqual(['/review', '<pr>', 'Review a pull request'])
  })

  it('keeps the Commands heading while the query filters out every skill', async () => {
    await open({ value: '/rev', slashCatalog: REPORTED })
    expect(texts()).toEqual(['Commands', '/review', '<pr>', 'Review a pull request'])
  })

  it('keeps an older host on the host-owned fallback commands, unheaded', async () => {
    await open({ slashCatalog: catalog(undefined) })
    expect(texts().filter((text) => String(text).startsWith('/'))).toEqual([
      '/model',
      '/effort',
      '/clear',
      '/compact'
    ])
    expect(texts()).not.toContain('Commands')
    expect(texts()).not.toContain('Skills')
  })

  it('serves the terminal lane the curated catalog', async () => {
    await open({ slashCatalog: undefined })
    expect(texts().filter((text) => String(text).startsWith('/'))).toEqual(
      getMobileNativeChatCommands('claude').map((command) => `/${command.name}`)
    )
    expect(texts()).not.toContain('Commands')
  })

  it("leaves OMP's /context out of the terminal lane; only desktop can answer it", async () => {
    await open({ agent: 'omp', slashCatalog: undefined, value: '/con' })
    expect(texts()).not.toContain('/context')
  })

  it('re-ranks per keystroke without re-selecting the catalog', async () => {
    await open({ slashCatalog: REPORTED })
    const selections = vi.mocked(nativeChatComposerCatalog).mock.calls.length
    await act(async () => {
      renderer!.update(
        createElement(MobileNativeChatComposer, props({ value: '/rev', slashCatalog: REPORTED }))
      )
    })
    const input = renderer!.root.find((node) => String(node.type) === 'TextInput')
    await act(async () => input.props.onSelectionChange({ nativeEvent: { selection: { end: 4 } } }))
    expect(texts()).toEqual(['Commands', '/review', '<pr>', 'Review a pull request'])
    expect(vi.mocked(nativeChatComposerCatalog).mock.calls.length).toBe(selections)
  })

  it('keeps file autocomplete on `@`', async () => {
    await open({ value: '@app', filePaths: ['src/apple.ts', 'docs/readme.md'] })
    expect(texts()).toEqual(['@src/apple.ts'])
    await act(async () => row('@src/apple.ts').props.onPress())
    expect(onChangeText).toHaveBeenLastCalledWith('@src/apple.ts ')
  })

  it('does not rebuild the rows when a streamed frame re-renders the composer', async () => {
    await open({ slashCatalog: REPORTED })
    const builds = vi.mocked(mobileNativeChatSlashMenu).mock.calls.length
    const before = sections()
    // A parent re-render with unrelated changes, as a streamed transcript frame causes.
    await act(async () => {
      renderer!.update(
        createElement(
          MobileNativeChatComposer,
          props({ slashCatalog: REPORTED, placeholder: 'Another frame' })
        )
      )
    })
    expect(vi.mocked(mobileNativeChatSlashMenu).mock.calls.length).toBe(builds)
    expect(sections()).toBe(before)

    const refreshed: AgentSessionSlashCommand[] = [...REPORT, { name: 'init', kind: 'command' }]
    await act(async () => {
      renderer!.update(
        createElement(MobileNativeChatComposer, props({ slashCatalog: catalog(refreshed) }))
      )
    })
    expect(vi.mocked(mobileNativeChatSlashMenu).mock.calls.length).toBe(builds + 1)
    expect(sections()).not.toBe(before)
    expect(texts()).toContain('/init')
  })
})
