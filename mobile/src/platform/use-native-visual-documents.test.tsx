import { StrictMode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { createFakeRpcClient, rpcSuccess } from '../mobile-web-shell/bridge-host-test-fakes'
import { useNativeVisualDocuments } from './use-native-visual-documents'

it('serves after Strict Mode effect replay and revokes documents when its page unmounts', async () => {
  const url =
    'https://page.orca-mobile-web.invalid/_orca_visual/00000000-0000-4000-8000-000000000001.html'
  const client = { current: createFakeRpcClient() }
  const release = vi.fn(async () => {})
  const view = {
    current: {
      sessionId: 'page-one',
      handle: {
        postBridgeMessage: vi.fn(async () => {}),
        createVisualDocument: vi.fn(async () => url),
        releaseVisualDocument: release
      }
    }
  }
  const fallback = { current: { serveNativeVerb: vi.fn(async () => ({})) } }
  const held: { serve: ReturnType<typeof useNativeVisualDocuments> | null } = { serve: null }
  function Probe() {
    held.serve = useNativeVisualDocuments('page-one', client, view, fallback)
    return null
  }
  let tree: ReactTestRenderer | null = null
  try {
    await act(async () => {
      tree = create(
        <StrictMode>
          <Probe />
        </StrictMode>
      )
    })
    const serve = held.serve
    if (!serve) {
      throw new Error('The page verb did not mount')
    }
    const pending = serve('native.visual.document', {
      action: 'open',
      sessionId: 'codex-report',
      file: 'report.html'
    })
    const request = client.current.requests[0]
    if (!request) {
      throw new Error('The page did not read its report')
    }
    request.resolve(
      rpcSuccess('report', { ok: true, html: '<button>Report</button>', revision: 'a'.repeat(64) })
    )
    await expect(pending).resolves.toMatchObject({ kind: 'ready', url })
    await act(async () => tree?.unmount())
    expect(release).toHaveBeenCalledExactlyOnceWith(url)
    await expect(serve('native.visual.document', { action: 'release', url })).rejects.toThrow(
      'no longer mounted'
    )
  } finally {
    await act(async () => tree?.unmount())
  }
})
