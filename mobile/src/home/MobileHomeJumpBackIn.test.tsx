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
vi.mock('../components/AgentSpinner', () => ({
  AgentSpinner: 'AgentSpinner',
  agentStatusColors: () => ({})
}))
vi.mock('../hooks/use-now', () => ({ useNow: () => 0 }))

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

function row(hostId: string, repo: string, fields?: Partial<HomeJumpBackInRow>): HomeJumpBackInRow {
  return {
    hostId,
    worktree: {
      worktreeId: `${hostId}:${repo}`,
      repo,
      branch: 'main',
      displayName: 'main',
      dotStatus: 'working'
    },
    lastOpened: false,
    actionable: true,
    ...fields
  }
}

describe('MobileHomeJumpBackIn', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  async function renderSection(rows: HomeJumpBackInRow[], hosts: HostCatalogEntry[]) {
    await act(async () => {
      renderer = create(createElement(MobileHomeJumpBackIn, { rows, hosts, onOpen: () => {} }))
    })
    return findAllByHostType(renderer!.root, 'Pressable').map(
      (pressable) => pressable.props.accessibilityLabel as string
    )
  }

  it('names the repo of same-branch workspaces across desktops (#37642)', async () => {
    const labels = await renderSection(
      [row('studio', 'orca'), row('laptop', 'website')],
      [host('studio', 'Studio'), host('laptop', 'Laptop')]
    )
    expect(labels).toEqual(['main, Working, orca · Studio', 'main, Working, website · Laptop'])
  })

  it('keeps the repo on a last-opened row that waits for its desktop', async () => {
    const labels = await renderSection(
      [row('laptop', 'website', { lastOpened: true, actionable: false })],
      [host('studio', 'Studio'), host('laptop', 'Laptop')]
    )
    expect(labels).toEqual(['main, Connect Laptop to open, website'])
  })
})
