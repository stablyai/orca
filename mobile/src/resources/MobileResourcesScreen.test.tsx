import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  HOST_RESOURCES_METHOD,
  HOST_RESOURCES_RUNTIME_CAPABILITY
} from '../../../src/shared/host-resources'
import { MobileResourcesScreen } from './MobileResourcesScreen'

const transport = vi.hoisted(() => {
  const sendRequest = vi.fn()
  return {
    state: 'connected' as 'connected' | 'disconnected',
    capabilities: ['host.resources.v1'] as readonly string[] | null,
    sendRequest,
    client: { sendRequest }
  }
})

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Animated: { View: 'View' },
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View'
}))

vi.mock('react-native-safe-area-context', () => ({
  SafeAreaView: 'SafeAreaView',
  useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 })
}))

vi.mock('react-native-svg', () => ({
  default: 'Svg',
  Circle: 'Circle'
}))

vi.mock('expo-router', async () => {
  const React = await import('react')
  return {
    useFocusEffect(effect: () => void | (() => void)): void {
      React.useEffect(effect, [effect])
    },
    useLocalSearchParams: () => ({ hostId: 'host-1' })
  }
})

vi.mock('lucide-react-native', () => ({
  Check: 'Check',
  ChevronDown: 'ChevronDown',
  ChevronLeft: 'ChevronLeft',
  ChevronRight: 'ChevronRight',
  Gauge: 'Gauge'
}))

vi.mock('../navigation/route-handoff', () => ({
  useRouteHandoff: () => ({ back: vi.fn() })
}))

vi.mock('../transport/host-client-hooks', () => ({
  useHostClient: () => ({
    client: transport.state === 'connected' ? transport.client : null,
    state: transport.state
  })
}))

vi.mock('../transport/runtime-status-probe', () => ({
  startRuntimeStatusProbe: (
    _client: unknown,
    onStatus: (status: { capabilities: readonly string[] } | null) => void
  ) => {
    onStatus(transport.capabilities === null ? null : { capabilities: transport.capabilities })
    return () => {}
  }
}))

function sampleResult(percent = 23) {
  return {
    id: 'resources-1',
    ok: true as const,
    result: {
      sampledAt: 1_700_000_000_000,
      uptimeSeconds: 90,
      cpu: {
        percent,
        coreCount: 2,
        model: 'Test CPU',
        loadAverage1m: 1.5,
        cores: [{ percent: 10 }, { percent: 36 }]
      },
      memory: {
        usedBytes: 4 * 1024 ** 3,
        totalBytes: 16 * 1024 ** 3,
        usedPercent: 25,
        swap: null
      },
      volumes: [
        {
          role: 'home' as const,
          usedBytes: 100,
          freeBytes: 300,
          totalBytes: 400,
          usedPercent: 25
        }
      ]
    }
  }
}

function labels(tree: ReactTestRenderer): string[] {
  return tree.root
    .findAll((node) => typeof node.props.accessibilityLabel === 'string')
    .map((node) => String(node.props.accessibilityLabel))
}

function text(tree: ReactTestRenderer): string[] {
  return tree.root
    .findAll((node) => String(node.type) === 'Text' && typeof node.props.children === 'string')
    .map((node) => String(node.props.children))
}

describe('MobileResourcesScreen', () => {
  let renderer: ReactTestRenderer | null = null

  beforeEach(() => {
    transport.state = 'connected'
    transport.capabilities = [HOST_RESOURCES_RUNTIME_CAPABILITY]
    transport.sendRequest.mockReset()
    transport.sendRequest.mockResolvedValue(sampleResult())
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  async function render(): Promise<ReactTestRenderer> {
    await act(async () => {
      renderer = create(createElement(MobileResourcesScreen))
    })
    if (renderer === null) {
      throw new Error('Resources screen did not render')
    }
    return renderer
  }

  it('says the host is not connected and does not sample', async () => {
    transport.state = 'disconnected'
    const tree = await render()
    expect(text(tree)).toContain('Not connected')
    expect(transport.sendRequest).not.toHaveBeenCalled()
  })

  it('asks for a server update when the capability is missing', async () => {
    transport.capabilities = []
    const tree = await render()
    expect(text(tree)).toContain('Update the server to see CPU, memory, and disk.')
    expect(transport.sendRequest).not.toHaveBeenCalled()
  })

  it('shows a read error when the status probe cannot decode the host', async () => {
    transport.capabilities = null
    const tree = await render()
    expect(text(tree)).toContain('Could not read server resources.')
    expect(text(tree)).not.toContain('Update the server to see CPU, memory, and disk.')
    expect(transport.sendRequest).not.toHaveBeenCalled()
  })

  it('shows CPU, memory, and disk from the connected host', async () => {
    const tree = await render()
    expect(transport.sendRequest).toHaveBeenCalledWith(HOST_RESOURCES_METHOD)
    expect(labels(tree)).toEqual(
      expect.arrayContaining([
        'CPU 23 percent',
        '4.00 GB of 16.0 GB, 25 percent',
        'Home, 300 B free of 400 B, 25 percent',
        'CPU over recent samples'
      ])
    )
    expect(text(tree)).toEqual(
      expect.arrayContaining([
        'Resources',
        '2 cores',
        'Test CPU',
        'Home',
        'Cores',
        'Under 60%',
        '60–79%',
        '80%+'
      ])
    )
  })

  it('stops polling when an older server refuses the method', async () => {
    transport.sendRequest.mockResolvedValue({
      id: 'resources-1',
      ok: false,
      error: { code: 'forbidden', message: 'no' }
    })
    const tree = await render()
    expect(text(tree)).toContain('Update the server to see CPU, memory, and disk.')
    expect(transport.sendRequest).toHaveBeenCalledTimes(1)
  })
})
