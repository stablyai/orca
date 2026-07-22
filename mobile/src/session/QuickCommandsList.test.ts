import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QUICK_COMMAND_SEARCH_QUERY_MAX_LENGTH, QuickCommandsList } from './QuickCommandsList'

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Pressable: 'Pressable',
  StyleSheet: {
    create: <T>(styles: T) => styles,
    hairlineWidth: 1
  },
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View'
}))

vi.mock('lucide-react-native', () => ({
  Check: 'Check',
  Pencil: 'Pencil',
  Play: 'Play',
  Plus: 'Plus',
  Search: 'Search',
  Trash2: 'Trash2'
}))

vi.mock('../components/MobileAgentIcon', () => ({ MobileAgentIcon: 'MobileAgentIcon' }))

describe('QuickCommandsList search', () => {
  let renderer: ReactTestRenderer | null = null

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it('keeps an active filter clearable when only one command remains', async () => {
    await act(async () => {
      renderer = create(
        createElement(QuickCommandsList, {
          repoCommands: [],
          globalCommands: [],
          totalCount: 1,
          query: 'missing',
          loading: false,
          disabled: false,
          canAdd: true,
          error: null,
          onQueryChange: vi.fn(),
          onLaunch: vi.fn(),
          onEdit: vi.fn(),
          onDelete: vi.fn(),
          onAdd: vi.fn()
        })
      )
    })

    const search = renderer!.root.findByType('TextInput')
    expect(search.props.value).toBe('missing')
    expect(search.props.maxLength).toBe(QUICK_COMMAND_SEARCH_QUERY_MAX_LENGTH)
  })

  it('omits idle search chrome for a single command', async () => {
    await act(async () => {
      renderer = create(
        createElement(QuickCommandsList, {
          repoCommands: [],
          globalCommands: [],
          totalCount: 1,
          query: '',
          loading: false,
          disabled: false,
          canAdd: true,
          error: null,
          onQueryChange: vi.fn(),
          onLaunch: vi.fn(),
          onEdit: vi.fn(),
          onDelete: vi.fn(),
          onAdd: vi.fn()
        })
      )
    })

    expect(renderer!.root.findAllByType('TextInput')).toHaveLength(0)
  })
})
