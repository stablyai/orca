import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { findAllByHostType } from '../test-support/react-test-renderer-host-nodes'
import type { HostCatalogEntry } from '../transport/types'
import type { HomeJumpBackInRow } from '../worktree/home-jump-back-in'
import { MobileHomeJumpBackIn } from './MobileHomeJumpBackIn'

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 0.5 },
  Text: 'Text',
  View: 'View'
}))
vi.mock('lucide-react-native', () => ({ ChevronRight: 'ChevronRight' }))
vi.mock('react-native-reanimated', () => ({ default: { View: 'View' } }))
vi.mock('../platform/use-reduced-motion', () => ({ useReducedMotionEnabled: () => true }))
vi.mock('./tabs/home-tabs', () => ({ HOME_EASE_OUT: null }))
vi.mock('../components/AgentSpinner', () => ({
  AgentSpinner: 'AgentSpinner',
  agentStatusColors: () => ({})
}))

function host(id: string, name: string): HostCatalogEntry {
  return {
    id,
    name,
    endpoint: `ws://${id}.local:8765`,
    publicKeyB64: 'key',
    lastConnected: 0,
    credentialStatus: 'ready',
    profile: null
  }
}

function row(
  hostId: string,
  worktree: { repo: string; displayName: string },
  fields?: Partial<HomeJumpBackInRow>
): HomeJumpBackInRow {
  return {
    hostId,
    worktree: {
      worktreeId: `${hostId}:${worktree.repo}`,
      branch: worktree.displayName,
      dotStatus: 'working',
      ...worktree
    },
    lastOpened: false,
    actionable: true,
    ...fields
  }
}

describe('MobileHomeJumpBackIn subtitles (#37642)', () => {
  let renderer: ReactTestRenderer | null = null
  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  function render(rows: HomeJumpBackInRow[], hosts: HostCatalogEntry[]): string[] {
    act(() => {
      renderer = create(
        createElement(MobileHomeJumpBackIn, { rows, hosts, first: true, onOpen() {} })
      )
    })
    return findAllByHostType(renderer!.root, 'Pressable').map((node) =>
      String(node.props.accessibilityLabel)
    )
  }

  it('names the repo, then the desktop, so same-branch workspaces differ', () => {
    const hosts = [host('mini', 'M1 Max'), host('box', 'Ubuntu')]
    expect(
      render(
        [
          row('mini', { repo: 'orca', displayName: 'main' }),
          row('box', { repo: 'website', displayName: 'main' }),
          row('box', { repo: 'docs', displayName: 'docs' }),
          row(
            'mini',
            { repo: 'orca', displayName: 'feature' },
            { lastOpened: true, actionable: false }
          )
        ],
        hosts
      )
    ).toEqual([
      'main, Working, orca · M1 Max',
      'main, Working, website · Ubuntu',
      'docs, Working, Ubuntu',
      'feature, Connect M1 Max to open, orca'
    ])
  })

  it('leaves the desktop out with only one paired', () => {
    expect(
      render([row('mini', { repo: 'orca', displayName: 'main' })], [host('mini', 'M1 Max')])
    ).toEqual(['main, Working, orca'])
  })
})
