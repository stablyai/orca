import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TaskProvider } from '../../../src/shared/task-providers'
import type { HostProfile } from '../transport/types'
import { MobileHomeListFooter } from './MobileHomeListFooter'

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  StyleSheet: { create: <T,>(styles: T) => styles },
  Text: 'Text',
  View: 'View'
}))

vi.mock('lucide-react-native', () => ({
  ChevronRight: 'ChevronRight',
  ListTodo: 'ListTodo',
  Plus: 'Plus',
  QrCode: 'QrCode'
}))

vi.mock('../components/TaskProviderLogo', () => ({ TaskProviderLogo: 'TaskProviderLogo' }))
vi.mock('./MobileHomeResumeCard', () => ({ MobileHomeResumeCard: 'MobileHomeResumeCard' }))
vi.mock('./MobileHomeAccountUsageCards', () => ({
  MobileHomeAccountUsageCards: 'MobileHomeAccountUsageCards'
}))

vi.mock('../components/PickerModal', () => ({ PickerModal: 'PickerModal' }))

function host(id: string, name: string, endpoint: string): HostProfile {
  return {
    id,
    name,
    endpoint,
    deviceToken: `token-${id}`,
    publicKeyB64: `key-${id}`,
    lastConnected: 1
  }
}

const desk = host('desk', 'Desk', 'ws://192.168.1.2:6768')
const laptop = host('laptop', 'Laptop', 'wss://relay.example.com/mobile')

const server = host('server', 'Server', 'wss://ssh.example.com/mobile')

describe('MobileHomeListFooter tasks', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    vi.restoreAllMocks()
  })

  async function renderFooter(
    connectedHosts: HostProfile[],
    taskProvidersByHost: Record<string, TaskProvider[]> = {}
  ) {
    const onOpenTasks = vi.fn()
    const onCreateWorkspace = vi.fn()
    const consoleError = vi.spyOn(console, 'error').mockImplementation((...args) => {
      if (typeof args[0] !== 'string' || !args[0].includes('react-test-renderer is deprecated')) {
        throw new Error(String(args[0]))
      }
    })
    await act(async () => {
      renderer = create(
        createElement(MobileHomeListFooter, {
          accountsHosts: [],
          connectedHosts,
          resumeCard: null,
          taskProvidersByHost,
          onCreateWorkspace,
          onOpenAccounts: vi.fn(),
          onOpenResume: vi.fn(),
          onOpenTasks,
          onPairDesktop: vi.fn()
        })
      )
    })
    consoleError.mockRestore()
    return { onOpenTasks, onCreateWorkspace }
  }

  function pressable(matches: (node: ReactTestInstance) => boolean) {
    const node = renderer!.root
      .findAll((candidate) => String(candidate.type) === 'Pressable')
      .find(matches)
    if (!node) {
      throw new Error('Pressable not rendered')
    }
    return node
  }

  function pressableWithText(text: string) {
    return pressable((node) =>
      node
        .findAll((candidate) => String(candidate.type) === 'Text')
        .some((candidate) => candidate.props.children === text)
    )
  }

  function providerChip(label: string) {
    return pressable((node) => node.props.accessibilityLabel === `Open ${label} tasks`)
  }

  function picker(title: string) {
    return renderer!.root
      .findAll((node) => String(node.type) === 'PickerModal')
      .find((node) => node.props.title === title)!
  }

  function tasksPicker() {
    return picker('Open Tasks On')
  }

  it('opens the only connected host directly', async () => {
    const callbacks = await renderFooter([desk])

    act(() => pressableWithText('Tasks').props.onPress())

    expect(callbacks.onOpenTasks).toHaveBeenCalledWith('desk', undefined)
    expect(tasksPicker().props.visible).toBe(false)
  })

  it('asks which connected host to open from the card', async () => {
    const callbacks = await renderFooter([desk, laptop])

    act(() => pressableWithText('Tasks').props.onPress())

    expect(callbacks.onOpenTasks).not.toHaveBeenCalled()
    expect(tasksPicker().props.visible).toBe(true)
    expect(tasksPicker().props.options).toEqual([
      { value: 'desk', label: 'Desk', subtitle: '192.168.1.2:6768' },
      { value: 'laptop', label: 'Laptop', subtitle: 'relay.example.com' }
    ])

    act(() => tasksPicker().props.onSelect('laptop'))
    act(() => tasksPicker().props.onAfterClose())

    expect(callbacks.onOpenTasks).toHaveBeenCalledWith('laptop', undefined)
  })

  it('lists each provider once, in the order connected hosts report them', async () => {
    await renderFooter([desk, laptop, server], {
      desk: ['github', 'jira'],
      laptop: ['gitlab', 'github'],
      server: ['jira', 'linear']
    })

    const labels = renderer!.root
      .findAll((node) => String(node.type) === 'TaskProviderLogo')
      .map((node) => node.props.provider)
    expect(labels).toEqual(['github', 'jira', 'gitlab', 'linear'])
  })

  it('opens a provider directly on the only host that has it', async () => {
    const callbacks = await renderFooter([desk, laptop], {
      desk: ['github'],
      laptop: ['github', 'jira']
    })

    act(() => providerChip('Jira').props.onPress({ stopPropagation: () => {} }))

    expect(tasksPicker().props.visible).toBe(false)
    expect(callbacks.onOpenTasks).toHaveBeenCalledWith('laptop', 'jira')
  })

  it('offers only the hosts that have the tapped provider', async () => {
    const callbacks = await renderFooter([desk, laptop, server], {
      desk: ['github', 'jira'],
      laptop: ['github'],
      server: ['jira']
    })

    act(() => providerChip('Jira').props.onPress({ stopPropagation: () => {} }))

    expect(tasksPicker().props.visible).toBe(true)
    expect(tasksPicker().props.options.map((option: { value: string }) => option.value)).toEqual([
      'desk',
      'server'
    ])
    act(() => tasksPicker().props.onSelect('server'))
    act(() => tasksPicker().props.onAfterClose())

    expect(callbacks.onOpenTasks).toHaveBeenCalledWith('server', 'jira')
  })
})
