import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DiscoveredSkill } from '../../../src/shared/skills'
import type {
  ComposerAutocomplete,
  NativeChatSkillDiscoverySnapshot
} from '../../../src/shared/native-chat/native-chat-composer-state'
import { deriveMobileNativeChatAutocomplete } from './mobile-native-chat-autocomplete'
import { MobileNativeChatPickerStrip } from './MobileNativeChatPickerStrip'
import {
  buildMobileNativeChatPickerPresentation,
  insertMobileNativeChatPickerItem,
  mobileNativeChatSkillScopeLabel,
  type MobileNativeChatPickerAutocomplete
} from './mobile-native-chat-strip'

vi.mock('react-native', async () => {
  const React = await import('react')
  return {
    ActivityIndicator: 'ActivityIndicator',
    Pressable: 'Pressable',
    ScrollView: ({ children, ...props }: { children?: unknown }) =>
      React.createElement('ScrollView', props, children),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Text: 'Text',
    View: 'View'
  }
})

vi.mock('lucide-react-native', () => ({ Package: 'Package', RotateCcw: 'RotateCcw' }))

function skill(overrides: Partial<DiscoveredSkill> = {}): DiscoveredSkill {
  const name = overrides.name ?? 'deploy'
  return {
    id: name,
    name,
    description: `Use ${name}`,
    providers: ['agent-skills'],
    sourceKind: 'repo',
    sourceLabel: 'Project',
    rootPath: '/skills',
    directoryPath: `/skills/${name}`,
    skillFilePath: `/skills/${name}/SKILL.md`,
    installed: true,
    fileCount: 1,
    updatedAt: null,
    ...overrides
  }
}

function picker(
  text: string,
  agent: 'codex' | 'claude',
  discovery: NativeChatSkillDiscoverySnapshot
): MobileNativeChatPickerAutocomplete {
  const autocomplete = deriveMobileNativeChatAutocomplete(text, text.length, agent, discovery)
  if (autocomplete.mode !== 'slash' && autocomplete.mode !== 'skill') {
    throw new Error('Expected picker autocomplete')
  }
  return autocomplete
}

describe('mobile native chat picker presentation', () => {
  it('keeps commands visible while skills load or fail', () => {
    const loading = buildMobileNativeChatPickerPresentation(
      picker('/', 'claude', { status: 'loading', skills: [] })
    )
    expect(loading.commands.length).toBeGreaterThan(0)
    expect(loading).toMatchObject({
      showCommandsHeading: true,
      showSkillsHeading: true,
      statusKind: 'loading',
      statusText: 'Loading skills...'
    })

    const failed = buildMobileNativeChatPickerPresentation(
      picker('/', 'claude', { status: 'error', skills: [], errorKind: 'unknown' })
    )
    expect(failed.commands.length).toBeGreaterThan(0)
    expect(failed).toMatchObject({ statusKind: 'error', canRetry: true })
  })

  it('hides Retry for unavailable hosts and describes empty merged results', () => {
    const unavailable = buildMobileNativeChatPickerPresentation(
      picker('$', 'codex', { status: 'error', skills: [], errorKind: 'unavailable' })
    )
    expect(unavailable).toMatchObject({
      statusText: 'Skills are unavailable for this host',
      canRetry: false
    })

    const empty = buildMobileNativeChatPickerPresentation(
      picker('/nothing-matches', 'claude', { status: 'ready', skills: [] })
    )
    expect(empty).toMatchObject({
      statusKind: 'empty',
      statusText: 'No matching commands or skills'
    })
  })

  it('inserts the shared token and trailing space as a verbatim controlled-field echo', () => {
    const autocomplete = picker('$dep', 'codex', {
      status: 'ready',
      skills: [skill({ name: 'deploy' })]
    })
    const item = autocomplete.items[0]!
    const result = insertMobileNativeChatPickerItem('$dep', 4, autocomplete, item)
    expect(result).toEqual({ text: '$deploy ', cursor: 8, insertedToken: '$deploy' })
    // Why: transforming this value before React Native writes it back terminates
    // active iOS dictation/IME input.
    expect(result.text).toBe(`${result.insertedToken} `)
  })

  it('uses the plugin badge label rather than a separate picker mode', () => {
    expect(mobileNativeChatSkillScopeLabel('plugin')).toBe('Plugin')
    const autocomplete = picker('$', 'codex', {
      status: 'ready',
      skills: [skill({ name: 'plugin-skill', sourceKind: 'plugin' })]
    })
    expect(autocomplete.items[0]).toMatchObject({
      kind: 'skill',
      sources: [expect.objectContaining({ sourceKind: 'plugin' })]
    })
  })
})

describe('MobileNativeChatPickerStrip', () => {
  let renderer: ReactTestRenderer | null = null

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it('renders a plugin source badge and invokes Retry without taking focus', async () => {
    const onRetry = vi.fn()
    const pluginAutocomplete = picker('$', 'codex', {
      status: 'ready',
      skills: [skill({ name: 'plugin-skill', sourceKind: 'plugin' })]
    })
    await renderStrip(pluginAutocomplete, onRetry)
    expect(renderer!.root.findByProps({ accessibilityLabel: 'Plugin source' })).toBeTruthy()
    expect(
      renderer!.root.findByProps({ accessibilityLabel: '$plugin-skill, Use plugin-skill, Plugin' })
    ).toBeTruthy()

    const failedAutocomplete = picker('$', 'codex', {
      status: 'error',
      skills: [],
      errorKind: 'timeout'
    })
    await act(async () => {
      renderer!.update(
        createElement(MobileNativeChatPickerStrip, {
          autocomplete: failedAutocomplete,
          onChoose: vi.fn(),
          onRetry
        })
      )
    })
    const retry = renderer!.root.findByProps({ accessibilityLabel: 'Retry loading skills' }) as {
      props: { onPress: () => void }
    }
    act(() => retry.props.onPress())
    expect(onRetry).toHaveBeenCalledOnce()
  })

  async function renderStrip(
    autocomplete: Extract<ComposerAutocomplete, { mode: 'slash' | 'skill' }>,
    onRetry: () => void
  ): Promise<void> {
    const restore = suppressRendererWarning()
    try {
      await act(async () => {
        renderer = create(
          createElement(MobileNativeChatPickerStrip, {
            autocomplete,
            onChoose: vi.fn(),
            onRetry
          })
        )
      })
    } finally {
      restore()
    }
  }
})

function suppressRendererWarning(): () => void {
  const original = console.error
  const spy = vi.spyOn(console, 'error').mockImplementation((...args) => {
    if (typeof args[0] === 'string' && args[0].includes('react-test-renderer is deprecated')) {
      return
    }
    original(...args)
  })
  return () => spy.mockRestore()
}
