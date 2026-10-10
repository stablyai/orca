// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Alert } from 'react-native'
import { RpcClientProvider } from '../transport/client-context.web'
import {
  createFakeBridgePortPair,
  type BridgePortPair
} from '../mobile-web-shell/bridge/bridge-port-pair-test-harness'
import { MobileSourceCopyButton } from './MobileSourceCopyButton'
import { colors } from '../theme/mobile-theme'

vi.mock('react-native', () => vi.importActual<typeof import('react-native')>('react-native-web'))
vi.mock('../platform/clipboard', () => vi.importActual('../platform/clipboard.web'))
vi.mock('lucide-react-native', () => ({
  Copy: ({ size, color }: { size: number; color: string }) =>
    createElement('svg', { 'data-icon': 'copy', width: size, height: size, stroke: color }),
  Check: ({ size, color }: { size: number; color: string }) =>
    createElement('svg', { 'data-icon': 'check', width: size, height: size, stroke: color })
}))
vi.mock('../transport/host-client-hooks', () => ({
  useDisconnectHostClient: () => () => {},
  useForceReconnect: () => null,
  useForgetHostClient: () => () => {},
  useHostClient: () => ({ client: null, clientId: null, state: 'disconnected' }),
  usePrimeHosts: () => () => {},
  useRefreshHostClient: () => () => {}
}))

function pendingWrite() {
  let finish: (written: boolean) => void = () => {
    throw new Error('No pending clipboard write')
  }
  const promise = new Promise<{ written: boolean }>((resolve) => {
    finish = (written) => resolve({ written })
  })
  return { promise, finish: (written: boolean) => finish(written) }
}

describe('source Copy feedback in the paired web page', () => {
  let root: Root | undefined
  let container: HTMLDivElement
  let pair: BridgePortPair
  const write = vi.fn<() => Promise<{ written: boolean }>>()
  const alert = vi.spyOn(Alert, 'alert')

  function button(): HTMLElement {
    const control = container.querySelector('[role="button"]')
    if (!(control instanceof HTMLElement)) {
      throw new Error('Copy control is missing')
    }
    return control
  }

  function expectIcon(name: 'copy' | 'check', color: string) {
    const icon = button().querySelector('svg')
    expect(icon?.getAttribute('data-icon')).toBe(name)
    expect(icon?.getAttribute('width')).toBe('14')
    expect(icon?.getAttribute('height')).toBe('14')
    expect(icon?.getAttribute('stroke')).toBe(color)
    expect(button().textContent).toBe('')
  }

  function expectFailure() {
    expectIcon('copy', colors.statusRed)
    expect(button().getAttribute('aria-label')).toBe("Couldn't copy")
    expect(button().getAttribute('aria-valuetext')).toBe("Couldn't copy")
  }

  async function render(text = '# Held source', partial = false) {
    await act(async () => {
      root?.render(
        <RpcClientProvider client={pair.client}>
          <MobileSourceCopyButton text={text} partial={partial} accessibilityLabel="Copy source" />
        </RpcClientProvider>
      )
    })
  }

  async function press() {
    await act(async () => {
      button().click()
      await pair.flush()
    })
  }

  beforeEach(async () => {
    write.mockReset().mockResolvedValue({ written: true })
    alert.mockClear()
    pair = createFakeBridgePortPair({ serveNativeVerb: write })
    await pair.flush()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root?.unmount())
    container.remove()
    vi.useRealTimers()
  })

  it('keeps a compact icon-only control through success and expiry', async () => {
    await render()
    vi.useFakeTimers()
    const initialClass = button().className
    expect(button().getAttribute('aria-label')).toBe('Copy source')
    expectIcon('copy', colors.textMuted)
    await press()
    expectIcon('check', colors.statusGreen)
    expect(button().getAttribute('aria-valuetext')).toBe('Copied')
    expect(button().className).toBe(initialClass)
    await act(async () => {
      vi.advanceTimersByTime(1500)
    })
    expectIcon('copy', colors.textMuted)
    expect(button().className).toBe(initialClass)
  })

  it.each(['rejected request', 'written:false'] as const)(
    'shows a visible failure for %s and allows retry',
    async (outcome) => {
      if (outcome === 'written:false') {
        write.mockResolvedValueOnce({ written: false })
      } else {
        write.mockRejectedValueOnce(new Error('Clipboard unavailable'))
      }
      await render()
      const initialClass = button().className
      await press()
      expectFailure()
      expect(button().className).toBe(initialClass)
      expect(alert).not.toHaveBeenCalled()
      expect(write).toHaveBeenCalledExactlyOnceWith('native.clipboard.write', {
        mime: 'text',
        value: '# Held source'
      })
      expect(pair.rpc.requests).toEqual([])
      await press()
      expectIcon('check', colors.statusGreen)
      expect(button().getAttribute('aria-label')).toBe('Copy source')
      expect(write).toHaveBeenCalledTimes(2)
    }
  )

  it('shows a missing-grant refusal without making a device call', async () => {
    pair = createFakeBridgePortPair({
      routeGrants: ['navigate', 'storage'],
      serveNativeVerb: write
    })
    await pair.flush()
    await render()
    await press()
    expectFailure()
    expect(write).not.toHaveBeenCalled()
    expect(alert).not.toHaveBeenCalled()
  })

  it('reports the mounted latest refusal after source updates and clears it on expiry', async () => {
    const pending = pendingWrite()
    write.mockReturnValueOnce(pending.promise)
    await render()
    vi.useFakeTimers()
    await press()
    await render('Streaming update')
    await act(async () => {
      pending.finish(false)
      await pair.flush()
    })
    expectFailure()
    expect(write).toHaveBeenCalledWith('native.clipboard.write', {
      mime: 'text',
      value: '# Held source'
    })
    await act(async () => {
      vi.advanceTimersByTime(1500)
    })
    expectIcon('copy', colors.textMuted)
  })

  it('keeps the latest failure visible across continued streaming until expiry', async () => {
    await render()
    vi.useFakeTimers()
    write.mockResolvedValueOnce({ written: false })
    await press()
    expectFailure()
    await render('Updated source')
    expectFailure()
    await render('Another streaming update')
    expectFailure()
    await act(async () => {
      vi.advanceTimersByTime(1500)
    })
    expectIcon('copy', colors.textMuted)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([true, false])('drops a superseded written:%s reply', async (written) => {
    const older = pendingWrite()
    write.mockReturnValueOnce(older.promise)
    await render()
    await press()
    write.mockResolvedValueOnce({ written: false })
    await press()
    expectFailure()
    await act(async () => {
      older.finish(written)
      await pair.flush()
    })
    expectFailure()
    expect(alert).not.toHaveBeenCalled()
  })

  it.each([true, false])('drops late written:%s feedback after unmount', async (written) => {
    const pending = pendingWrite()
    write.mockReturnValueOnce(pending.promise)
    await render()
    vi.useFakeTimers()
    await press()
    await act(async () => root?.unmount())
    root = undefined
    await act(async () => {
      pending.finish(written)
      await pair.flush()
    })
    expect(container.textContent).toBe('')
    expect(alert).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps success stale after an A to B to A source change', async () => {
    const pending = pendingWrite()
    write.mockReturnValueOnce(pending.promise)
    await render()
    vi.useFakeTimers()
    await press()
    await render('Other source')
    await render()
    await act(async () => {
      pending.finish(true)
      await pair.flush()
    })
    expectIcon('copy', colors.textMuted)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('restores the loaded-source label after failure expires', async () => {
    await render('# Loaded portion', true)
    vi.useFakeTimers()
    write.mockResolvedValueOnce({ written: false })
    await press()
    expect(button().textContent).toBe('Failed')
    await act(async () => {
      vi.advanceTimersByTime(1500)
    })
    expect(button().textContent).toBe('Copy loaded')
    expect(write).toHaveBeenCalledWith('native.clipboard.write', {
      mime: 'text',
      value: '# Loaded portion'
    })
  })

  it('confirms the loaded portion without changing the partial footprint', async () => {
    await render('# Loaded portion', true)
    const initialClass = button().className
    expect(button().textContent).toBe('Copy loaded')
    await press()
    expect(button().textContent).toBe('Copied loaded')
    expect(button().querySelector('svg')?.getAttribute('data-icon')).toBe('check')
    expect(button().getAttribute('aria-valuetext')).toBe('Copied loaded')
    expect(button().className).toBe(initialClass)
    expect(write).toHaveBeenCalledWith('native.clipboard.write', {
      mime: 'text',
      value: '# Loaded portion'
    })
  })
})
