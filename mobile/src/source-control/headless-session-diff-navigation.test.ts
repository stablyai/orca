import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFakeRpcClient } from '../mobile-web-shell/bridge-host-test-fakes'
import { useMobileSourceControlOpeners } from './use-mobile-source-control-openers'

const router = vi.hoisted(() => ({ push: vi.fn(), back: vi.fn() }))
vi.mock('../navigation/route-handoff', () => ({ useRouteHandoff: () => router }))
vi.mock('../platform/haptics', () => ({ triggerSelection: vi.fn(), triggerError: vi.fn() }))

describe('headless session diff navigation', () => {
  let renderer: ReactTestRenderer | null = null
  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    router.push.mockClear()
  })

  it.each([false, true])(
    'only reveals the diff while the source tab is current: %s',
    async (current) => {
      const client = createFakeRpcClient()
      let sourceCurrent = true
      const controller: { current: ReturnType<typeof useMobileSourceControlOpeners> | null } = {
        current: null
      }
      function Probe() {
        controller.current = useMobileSourceControlOpeners({
          client,
          connState: 'connected',
          hostId: 'host-1',
          worktreeId: 'wt-1',
          name: 'feature',
          origin: 'session',
          embedded: true,
          onFileOpenStart: () => () => sourceCurrent,
          branchCompareState: { kind: 'idle' },
          mountedRef: { current: true },
          busyActionRef: { current: null },
          setActionError: vi.fn()
        })
        return null
      }
      await act(async () => {
        renderer = create(createElement(Probe))
      })
      if (!controller.current) {
        throw new Error('source control did not mount')
      }
      const opening = controller.current.openFile({
        path: 'notes.md',
        status: 'modified',
        area: 'unstaged'
      })
      const request = client.requests[0]
      expect(request?.method).toBe('files.openDiff')
      sourceCurrent = current
      await act(async () => {
        request?.resolve({
          id: 'diff-1',
          ok: false,
          error: { code: 'runtime_error', message: 'renderer_unavailable' }
        })
        await opening
      })
      expect(router.push).toHaveBeenCalledTimes(current ? 1 : 0)
      expect(client.requests).toHaveLength(1)
    }
  )
})
