import { createElement, type ComponentProps, type ElementType, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileNativeChatComposer as NativeChatComposer } from './MobileNativeChatComposer'

const getNoComposerEditGeneration = () => 0

// The react-native mock maps every export to a plain string element type; the
// test program's ElementType carries no react-native names, so bridge the seam.
function hostType(name: string): ElementType {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each mock export renders as exactly this string element type.
  return name as ElementType
}

function MobileNativeChatComposer({
  getComposerEditGeneration = getNoComposerEditGeneration,
  ...props
}: Omit<ComponentProps<typeof NativeChatComposer>, 'getComposerEditGeneration'> & {
  getComposerEditGeneration?: () => number
}): React.JSX.Element {
  return createElement(NativeChatComposer, {
    ...props,
    getComposerEditGeneration
  })
}

vi.mock('react-native', async () => {
  const React = await import('react')
  return {
    ActivityIndicator: 'ActivityIndicator',
    Keyboard: { dismiss: vi.fn() },
    Pressable: 'Pressable',
    ScrollView: ({ children, ...props }: { children?: ReactNode }) =>
      React.createElement('ScrollView', props, children),
    StyleSheet: {
      create: (styles: unknown) => styles,
      hairlineWidth: 1
    },
    Text: 'Text',
    TextInput: 'TextInput',
    View: 'View'
  }
})

vi.mock('lucide-react-native', () => ({
  ArrowUp: 'ArrowUp',
  Check: 'Check',
  ChevronDown: 'ChevronDown',
  ChevronLeft: 'ChevronLeft',
  ChevronRight: 'ChevronRight',
  ImagePlus: 'ImagePlus',
  Mic: 'Mic',
  Square: 'Square',
  X: 'X'
}))

// The option pickers the composer mounts render through BottomDrawer; the real
// component pulls RN pieces the react-native mock above does not provide.
vi.mock('../components/BottomDrawer', async () => {
  const React = await import('react')
  return {
    BottomDrawer: ({ visible, children }: { visible: boolean; children?: ReactNode }) =>
      visible ? React.createElement('BottomDrawer', { visible }, children) : null
  }
})

describe('MobileNativeChatComposer slash menu', () => {
  let renderer: ReactTestRenderer | null = null
  const getCurrentSendCompletionGeneration = () => 0

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it('serves the active agent’s shared command catalog with descriptions', async () => {
    await act(async () => {
      renderer = create(
        createElement(MobileNativeChatComposer, {
          value: '/',
          onChangeText: vi.fn(),
          onSend: vi.fn().mockResolvedValue(true),
          sendSurfaceId: 'tab-a',
          getSendCompletionGeneration: getCurrentSendCompletionGeneration,
          agent: 'codex'
        })
      )
    })
    const input = renderer!.root.find((node) => node.type === hostType('TextInput'))
    await act(async () => input.props.onSelectionChange({ nativeEvent: { selection: { end: 1 } } }))
    const texts = renderer!.root
      .findAll((node) => node.type === hostType('Text'))
      .map((node) => (node.props as { children?: ReactNode }).children)
    // Codex-only commands from the shared catalog, with their description rows —
    // and none of the old hardcoded provider-agnostic list's phantom entries.
    expect(texts).toContain('/permissions')
    expect(texts).toContain('Choose what Codex is allowed to do')
    expect(texts).not.toContain('/cost')
  })

  it("serves the structured session's reported commands over every curated list", async () => {
    await act(async () => {
      renderer = create(
        createElement(MobileNativeChatComposer, {
          value: '/',
          onChangeText: vi.fn(),
          onSend: vi.fn().mockResolvedValue(true),
          sendSurfaceId: 'tab-a',
          getSendCompletionGeneration: getCurrentSendCompletionGeneration,
          agent: 'claude',
          structuredCommands: [],
          sessionCommands: [
            { name: 'clear', kind: 'command' },
            { name: 'opsx:apply', kind: 'command' }
          ]
        })
      )
    })
    const input = renderer!.root.find((node) => node.type === hostType('TextInput'))
    await act(async () => input.props.onSelectionChange({ nativeEvent: { selection: { end: 1 } } }))
    const texts = renderer!.root
      .findAll((node) => node.type === hostType('Text'))
      .map((node) => (node.props as { children?: ReactNode }).children)
    // The report is the authority: its commands show (described where the
    // curated catalog knows the name) and neither curated-only entries nor the
    // structured base commands resurface.
    expect(texts).toContain('/clear')
    expect(texts).toContain('Clear conversation history')
    expect(texts).toContain('/opsx:apply')
    expect(texts).not.toContain('/compact')
    expect(texts).not.toContain('/model')
  })

  it("offers the session's reported skills in the slash menu, marked and insertable", async () => {
    const onChangeText = vi.fn()
    await act(async () => {
      renderer = create(
        createElement(MobileNativeChatComposer, {
          value: '/to',
          onChangeText,
          onSend: vi.fn().mockResolvedValue(true),
          sendSurfaceId: 'tab-a',
          getSendCompletionGeneration: getCurrentSendCompletionGeneration,
          agent: 'claude',
          structuredCommands: [],
          sessionCommands: [
            { name: 'clear', kind: 'command' },
            { name: 'to-spec', kind: 'skill' }
          ]
        })
      )
    })
    const input = renderer!.root.find((node) => node.type === hostType('TextInput'))
    await act(async () => input.props.onSelectionChange({ nativeEvent: { selection: { end: 4 } } }))
    const texts = renderer!.root
      .findAll((node) => node.type === hostType('Text'))
      .map((node) => (node.props as { children?: ReactNode }).children)
    // The reported skill matches the prefix; the unmatched command does not show.
    expect(texts).toContain('/to-spec')
    expect(texts).toContain('skill')
    expect(texts).not.toContain('/clear')

    const skillRow = renderer!.root.findAll(
      (node) => node.type === hostType('Pressable') && !node.props.accessibilityLabel
    )[0]
    await act(async () => skillRow.props.onPress())
    expect(onChangeText).toHaveBeenCalledWith('/to-spec ')
  })

  it('keeps a command that collides with a skill name as the described command row', async () => {
    await act(async () => {
      renderer = create(
        createElement(MobileNativeChatComposer, {
          value: '/',
          onChangeText: vi.fn(),
          onSend: vi.fn().mockResolvedValue(true),
          sendSurfaceId: 'tab-a',
          getSendCompletionGeneration: getCurrentSendCompletionGeneration,
          agent: 'claude',
          structuredCommands: [],
          sessionCommands: [
            { name: 'clear', kind: 'command' },
            { name: 'clear', kind: 'skill' },
            { name: 'to-spec', kind: 'skill' }
          ]
        })
      )
    })
    const input = renderer!.root.find((node) => node.type === hostType('TextInput'))
    await act(async () => input.props.onSelectionChange({ nativeEvent: { selection: { end: 1 } } }))
    const texts = renderer!.root
      .findAll((node) => node.type === hostType('Text'))
      .map((node) => (node.props as { children?: ReactNode }).children)
    expect(texts.filter((text) => text === '/clear')).toHaveLength(1)
    expect(texts).toContain('Clear conversation history')
  })

  it('offers discovered worktree skills with descriptions on the PTY lane', async () => {
    const onChangeText = vi.fn()
    await act(async () => {
      renderer = create(
        createElement(MobileNativeChatComposer, {
          value: '/de',
          onChangeText,
          onSend: vi.fn().mockResolvedValue(true),
          sendSurfaceId: 'tab-a',
          getSendCompletionGeneration: getCurrentSendCompletionGeneration,
          agent: 'claude',
          skillSuggestions: [{ name: 'deploy-check', description: 'Verify the deploy' }]
        })
      )
    })
    const input = renderer!.root.find((node) => node.type === hostType('TextInput'))
    await act(async () => input.props.onSelectionChange({ nativeEvent: { selection: { end: 4 } } }))
    const texts = renderer!.root
      .findAll((node) => node.type === hostType('Text'))
      .map((node) => (node.props as { children?: ReactNode }).children)
    expect(texts).toContain('/deploy-check')
    expect(texts).toContain('Verify the deploy')
    expect(texts).toContain('skill')

    const skillRow = renderer!.root.findAll(
      (node) => node.type === hostType('Pressable') && !node.props.accessibilityLabel
    )[0]
    await act(async () => skillRow.props.onPress())
    expect(onChangeText).toHaveBeenCalledWith('/deploy-check ')
  })

  it('inserts a Codex skill with the $ sigil the agent dispatches', async () => {
    const onChangeText = vi.fn()
    await act(async () => {
      renderer = create(
        createElement(MobileNativeChatComposer, {
          value: '/dep',
          onChangeText,
          onSend: vi.fn().mockResolvedValue(true),
          sendSurfaceId: 'tab-a',
          getSendCompletionGeneration: getCurrentSendCompletionGeneration,
          agent: 'codex',
          skillSuggestions: [{ name: 'deploy-check', description: 'Verify the deploy' }]
        })
      )
    })
    const input = renderer!.root.find((node) => node.type === hostType('TextInput'))
    await act(async () => input.props.onSelectionChange({ nativeEvent: { selection: { end: 4 } } }))
    const texts = renderer!.root
      .findAll((node) => node.type === hostType('Text'))
      .map((node) => (node.props as { children?: ReactNode }).children)
    // '/dep' matches only the skill, so the first row is the deploy-check skill.
    expect(texts).toContain('$deploy-check')

    const skillRow = renderer!.root.findAll(
      (node) => node.type === hostType('Pressable') && !node.props.accessibilityLabel
    )[0]
    await act(async () => skillRow.props.onPress())
    expect(onChangeText).toHaveBeenCalledWith('$deploy-check ')
  })

  it('offers a Codex command and a same-named skill as separate rows', async () => {
    await act(async () => {
      renderer = create(
        createElement(MobileNativeChatComposer, {
          value: '/review',
          onChangeText: vi.fn(),
          onSend: vi.fn().mockResolvedValue(true),
          sendSurfaceId: 'tab-a',
          getSendCompletionGeneration: getCurrentSendCompletionGeneration,
          agent: 'codex',
          skillSuggestions: [{ name: 'review', description: 'Inspect the change' }]
        })
      )
    })
    const input = renderer!.root.find((node) => node.type === hostType('TextInput'))
    await act(async () => input.props.onSelectionChange({ nativeEvent: { selection: { end: 7 } } }))
    const texts = renderer!.root
      .findAll((node) => node.type === hostType('Text'))
      .map((node) => (node.props as { children?: ReactNode }).children)
    // Distinct sigils, distinct rows: the curated command and the disk skill.
    expect(texts.filter((text) => text === '/review')).toHaveLength(1)
    expect(texts.filter((text) => text === '$review')).toHaveLength(1)
    expect(texts).toContain('skill')
  })

  it('keeps the skill tag on an unclassified command that merged onto its skill row', async () => {
    const onChangeText = vi.fn()
    await act(async () => {
      renderer = create(
        createElement(MobileNativeChatComposer, {
          value: '/gr',
          onChangeText,
          onSend: vi.fn().mockResolvedValue(true),
          sendSurfaceId: 'tab-a',
          getSendCompletionGeneration: getCurrentSendCompletionGeneration,
          agent: 'claude',
          structuredCommands: [],
          sessionCommands: [
            { name: 'clear', kind: 'command' },
            { name: 'grill', kind: 'command', kindUnspecified: true },
            { name: 'grill', kind: 'skill' }
          ],
          skillSuggestions: [{ name: 'grill', description: 'Stress-test the plan' }]
        })
      )
    })
    const input = renderer!.root.find((node) => node.type === hostType('TextInput'))
    await act(async () => input.props.onSelectionChange({ nativeEvent: { selection: { end: 3 } } }))
    const texts = renderer!.root
      .findAll((node) => node.type === hostType('Text'))
      .map((node) => (node.props as { children?: ReactNode }).children)
    // The merged row stays a skill: tag shown, description from disk.
    expect(texts.filter((text) => text === '/grill')).toHaveLength(1)
    expect(texts).toContain('skill')
    expect(texts).toContain('Stress-test the plan')

    const skillRow = renderer!.root.findAll(
      (node) => node.type === hostType('Pressable') && !node.props.accessibilityLabel
    )[0]
    await act(async () => skillRow.props.onPress())
    expect(onChangeText).toHaveBeenCalledWith('/grill ')
  })
})
