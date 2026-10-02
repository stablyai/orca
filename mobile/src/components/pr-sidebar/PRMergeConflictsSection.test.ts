import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PRMergeConflictsSection } from './PRMergeConflictsSection'

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Pressable: 'Pressable',
  StyleSheet: { create: (styles: unknown) => styles },
  Text: 'Text',
  View: 'View'
}))

vi.mock('lucide-react-native', () => ({ Sparkles: 'Sparkles' }))

vi.mock('./PRSection', () => ({
  PRSection: ({ children }: { children: unknown }) => children
}))

vi.mock('../AgentLaunchNotice', () => ({ AgentLaunchNotice: () => null }))

function labels(tree: ReactTestRenderer): string[] {
  return tree.root
    .findAll((node) => typeof node.props.children === 'string')
    .flatMap((node) => (typeof node.props.children === 'string' ? [node.props.children] : []))
}

describe('PRMergeConflictsSection', () => {
  let tree: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => tree?.unmount())
    tree = null
  })

  it('names the host and base branch instead of listing files', () => {
    act(() => {
      tree = create(
        createElement(PRMergeConflictsSection, {
          pr: { mergeable: 'CONFLICTING', baseRefName: 'main' },
          triage: {
            resolveConflicts: () => {},
            isBusy: false,
            availability: 'available',
            success: null,
            error: null,
            warning: null,
            undeliveredPrompt: null
          }
        })
      )
    })
    const rendered = labels(tree!)
    expect(rendered).toContain('GitHub reports conflicts with main')
    expect(rendered).toContain(
      'Merge main into this branch to see and resolve the conflicting files.'
    )
    expect(rendered).toContain('Resolve conflicts with AI')
    expect(rendered.join('\n')).not.toMatch(/Conflicting files|unavailable|Refreshing/)
  })

  it('renders nothing when GitHub reports no conflict', () => {
    act(() => {
      tree = create(
        createElement(PRMergeConflictsSection, {
          pr: { mergeable: 'MERGEABLE', baseRefName: 'main' }
        })
      )
    })
    expect(tree!.toJSON()).toBeNull()
  })
})
