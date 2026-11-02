import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { findAllByHostType } from '../test-support/react-test-renderer-host-nodes'
import { colors } from '../theme/mobile-theme'
import type { ConnectionVerdict } from '../transport/connection-health'
import type { ConnectionState, HostCredentialStatus, HostProfile } from '../transport/types'
import {
  markHomeWorktreeCatalogUnavailable,
  type HostWorktreeInfo
} from '../worktree/home-worktree-info'
import { MobileHomeDesktopRow } from './MobileHomeDesktopRow'

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 0.5 },
  Text: 'Text',
  View: 'View'
}))
vi.mock('lucide-react-native', () => ({ ChevronRight: 'ChevronRight' }))
vi.mock('../components/StatusDot', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  StatusDot: 'StatusDot'
}))

const host: HostProfile = {
  id: 'host-1',
  name: 'Studio',
  endpoint: 'ws://studio.local:8765',
  deviceToken: 'token',
  publicKeyB64: 'key',
  lastConnected: 0
}
const NOW = 1_800_000_000_000
const connectedVerdict: ConnectionVerdict = { kind: 'normal', label: 'Connected' }
const loaded: HostWorktreeInfo = {
  hostId: 'host-1',
  totalWorktrees: 12,
  activeCount: 2,
  lastActiveWorktree: null,
  countsProvenAt: NOW
}

describe('MobileHomeDesktopRow', () => {
  let renderer: ReactTestRenderer | null = null

  // The row ages counts against the clock; pin it so "proven just now" stays true.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW })
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    vi.useRealTimers()
  })

  async function renderRow(
    worktreeInfo: HostWorktreeInfo | undefined,
    overrides?: {
      state?: ConnectionState
      verdict?: ConnectionVerdict
      credentialStatus?: HostCredentialStatus
      host?: HostProfile
      onLongPress?: () => void
    }
  ) {
    await act(async () => {
      renderer = create(
        createElement(MobileHomeDesktopRow, {
          host: overrides?.host ?? host,
          state: overrides?.state ?? 'connected',
          verdict: overrides?.verdict ?? connectedVerdict,
          path: 'lan',
          credentialStatus: overrides?.credentialStatus,
          worktreeInfo,
          onPress: () => {},
          onLongPress: overrides?.onLongPress ?? (() => {})
        })
      )
    })
    const root = renderer!.root
    const texts = findAllByHostType(root, 'Text')
    return {
      lines: texts.flatMap((node) => node.children.filter((child) => typeof child === 'string')),
      texts,
      row: findAllByHostType(root, 'Pressable')[0]
    }
  }

  it('renders the counts the host proved', async () => {
    expect((await renderRow(loaded)).lines).toContain('12 worktrees · 2 active')
  })

  it('keeps rendering the last proven counts after a failed refresh', async () => {
    const { lines } = await renderRow(markHomeWorktreeCatalogUnavailable(loaded, 'host-1'))
    expect(lines).toContain('Last known: 12 worktrees · 2 active')
  })

  it('never asserts a count for a catalog that failed with nothing proven', async () => {
    const { lines } = await renderRow(markHomeWorktreeCatalogUnavailable(undefined, 'host-1'))
    expect(lines).toContain('Worktree list unavailable')
  })

  it('offers re-pairing when the credential is missing, instead of counts', async () => {
    const { lines } = await renderRow(loaded, {
      verdict: { kind: 'auth-failed', label: 'Pairing invalid' },
      credentialStatus: 'missing'
    })
    expect(lines).toContain('Pairing invalid')
    expect(lines).toContain('Tap to re-pair with your desktop')
    expect(lines).not.toContain('12 worktrees · 2 active')
  })

  it('offers a retry without declaring a transient read failure invalid', async () => {
    const { lines } = await renderRow(undefined, {
      state: 'disconnected',
      verdict: { kind: 'normal', label: 'Disconnected' },
      credentialStatus: 'temporarily-unavailable'
    })
    expect(lines).toContain('Pairing temporarily unavailable')
    expect(lines).toContain('Unlock your phone, then tap to retry')
    expect(lines).not.toContain('Pairing invalid')
  })

  it('colours a warning amber like its dot, not red', async () => {
    const { texts } = await renderRow(undefined, {
      state: 'reconnecting',
      verdict: { kind: 'warning', label: "Can't connect", detail: 'Check Tailscale' }
    })
    const status = texts.find((node) => node.children.includes("Can't connect"))
    expect(status?.props.style).toContainEqual({ color: colors.statusAmber })
  })

  it('shows and announces the fix for an offline desktop', async () => {
    const { lines, row } = await renderRow(undefined, {
      host: { ...host, name: 'Desk' },
      state: 'reconnecting',
      verdict: {
        kind: 'unreachable',
        label: "Can't reach desktop",
        reason: 'never-connected',
        detail: "Check it's awake, Orca is running, and you're signed in"
      }
    })
    expect(lines).toContain("Check it's awake, Orca is running, and you're signed in")
    expect(row.props.accessibilityLabel).toBe(
      "Open Desk, Can't reach desktop, Update desktop Orca and sign in to connect from anywhere, Check it's awake, Orca is running, and you're signed in"
    )
  })

  it('opens the desktop menu from the accessibility long-press action', async () => {
    const onLongPress = vi.fn()
    const { row } = await renderRow(loaded, { onLongPress })
    act(() => row.props.onAccessibilityAction({ nativeEvent: { actionName: 'longpress' } }))
    expect(onLongPress).toHaveBeenCalledTimes(1)
  })
})
