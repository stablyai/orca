import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionVerdict } from '../transport/connection-health'
import type { MobileConnectionPath } from '../transport/stable-logical-rpc-client'
import type { ConnectionState, HostProfile } from '../transport/types'
import {
  markHomeWorktreeCatalogUnavailable,
  type HostWorktreeInfo
} from '../worktree/home-worktree-info'
import { MobileHostCard } from './MobileHostCard'

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  StyleSheet: { create: <T,>(styles: T) => styles },
  Text: 'Text',
  View: 'View'
}))
vi.mock('lucide-react-native', () => ({ ChevronRight: 'ChevronRight', Monitor: 'Monitor' }))
vi.mock('./StatusDot', () => ({ StatusDot: 'StatusDot' }))

const host: HostProfile = {
  id: 'host-1',
  name: 'Studio',
  endpoint: 'ws://studio.local:8765',
  deviceToken: 'token',
  publicKeyB64: 'key',
  lastConnected: 0
}
const verdict: ConnectionVerdict = { kind: 'normal', label: 'Connected' }
const loaded: HostWorktreeInfo = {
  hostId: 'host-1',
  totalWorktrees: 12,
  activeCount: 2,
  lastActiveWorktree: null,
  countsProvenAt: Date.now()
}

describe('MobileHostCard', () => {
  let renderer: ReactTestRenderer | null = null

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  async function renderCard(
    worktreeInfo: HostWorktreeInfo | undefined,
    overrides?: {
      state?: ConnectionState
      verdict?: ConnectionVerdict
      path?: MobileConnectionPath
    }
  ): Promise<string[]> {
    await act(async () => {
      renderer = create(
        createElement(MobileHostCard, {
          host,
          state: overrides?.state ?? 'connected',
          verdict: overrides?.verdict ?? verdict,
          path: overrides?.path ?? 'lan',
          worktreeInfo,
          onPress: () => {},
          onLongPress: () => {}
        })
      )
    })
    return renderer!.root
      .findAllByType('Text')
      .flatMap((node) => node.children.filter((child) => typeof child === 'string'))
  }

  it('renders the counts the host proved', async () => {
    expect(await renderCard(loaded)).toContain('12 worktrees · 2 active')
  })

  it('keeps rendering the last proven counts after a failed refresh', async () => {
    // The regression this card shipped once: the caller dropped the counts the
    // failure path deliberately preserved.
    expect(await renderCard(markHomeWorktreeCatalogUnavailable(loaded, 'host-1'))).toContain(
      'Last known: 12 worktrees · 2 active'
    )
  })

  it('never asserts a count for a catalog that failed with nothing proven', async () => {
    expect(await renderCard(markHomeWorktreeCatalogUnavailable(undefined, 'host-1'))).toContain(
      'Worktree list unavailable'
    )
  })

  it('names the relay while the dial is still in flight', async () => {
    const lines = await renderCard(undefined, {
      state: 'connecting',
      verdict: { kind: 'normal', label: 'Connecting…' },
      path: 'relay'
    })

    expect(lines).toContain('Connecting…')
    expect(lines).toContain(' · Orca Relay')
  })

  it('names the relay while a failed direct dial is still retrying', async () => {
    const lines = await renderCard(undefined, {
      state: 'reconnecting',
      verdict: { kind: 'normal', label: 'Reconnecting…' },
      path: 'relay'
    })

    expect(lines).toContain(' · Orca Relay')
  })

  it('leaves an idle disconnected host unlabelled', async () => {
    const lines = await renderCard(undefined, {
      state: 'disconnected',
      verdict: { kind: 'normal', label: 'Disconnected' },
      path: 'relay'
    })

    expect(lines).not.toContain(' · Orca Relay')
  })

  it('does not guess a direct path before the dial resolves', async () => {
    const lines = await renderCard(undefined, {
      state: 'connecting',
      verdict: { kind: 'normal', label: 'Connecting…' },
      path: 'lan'
    })

    expect(lines).not.toContain(' · Direct · LAN')
  })

  it('shows no worktree line before the first read lands', async () => {
    const lines = await renderCard(undefined)

    expect(lines).not.toContain('0 worktrees')
    expect(lines).not.toContain('Worktree list unavailable')
  })

  it('explains automatic recovery and exposes Reconnect now', async () => {
    const reconnect = vi.fn()
    const stopPropagation = vi.fn()
    await act(async () => {
      renderer = create(
        createElement(MobileHostCard, {
          host,
          state: 'connected',
          verdict: {
            kind: 'warning',
            label: 'Desktop not responding',
            reason: 'unresponsive'
          },
          path: 'lan',
          statusActions: [{ label: 'Reconnect now', onPress: reconnect }],
          onPress: () => {},
          onLongPress: () => {}
        })
      )
    })

    const text = renderer!.root
      .findAllByType('Text')
      .flatMap((node) => node.children.filter((child) => typeof child === 'string'))
    expect(text).toContain(
      "The connection is open, but desktop Orca isn't answering. Orca is checking the connection and will retry automatically."
    )
    const action = renderer!.root.findByProps({ accessibilityLabel: 'Reconnect now' })
    act(() => action.props.onPress({ stopPropagation }))
    expect(stopPropagation).toHaveBeenCalledOnce()
    expect(reconnect).toHaveBeenCalledOnce()
  })
})
