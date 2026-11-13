import { describe, expect, it, vi } from 'vitest'
import type { OrcaMobileWebShellViewHandle } from '../../modules/orca-mobile-web-shell/src'
import { createFakeRpcClient, rpcSuccess } from '../mobile-web-shell/bridge-host-test-fakes'
import { createNativeVisualDocumentServer } from './native-visual-documents'

const url =
  'https://page.orca-mobile-web.invalid/_orca_visual/00000000-0000-4000-8000-000000000001.html'
const params = { action: 'open', sessionId: 'codex-report', file: 'report.html' }
const html = '<button onclick="this.textContent=\'Changed\'">Switch</button>'

function view(): OrcaMobileWebShellViewHandle {
  return {
    postBridgeMessage: vi.fn(async () => {}),
    createVisualDocument: vi.fn(async () => url),
    releaseVisualDocument: vi.fn(async () => {})
  }
}

function fixture() {
  const client = createFakeRpcClient()
  const initial = view()
  let current = initial
  const server = createNativeVisualDocumentServer({
    readClient: () => client,
    readView: () => current
  })
  const answer = () => {
    const request = client.requests[0]
    if (!request) {
      throw new Error('The host was not asked for the report')
    }
    request.resolve(rpcSuccess('report-read', { ok: true, html, revision: 'a'.repeat(64) }))
  }
  return {
    server,
    client,
    initial,
    answer,
    replace: () => {
      current = view()
      return current
    }
  }
}

describe('interactive reports owned by one mobile page', () => {
  it('reads the owning remote host and releases its issued native document', async () => {
    const { server, client, initial, answer } = fixture()
    const pending = server.serve({ ...params, executionHost: 'runtime:server-a' })
    expect(client.requests[0]).toMatchObject({
      method: 'agentSession.readVisual',
      args: [
        'agentSession.readVisual',
        { sessionId: 'codex-report', file: 'report.html' },
        expect.objectContaining({ envelope: { executionHost: 'runtime:server-a' } })
      ]
    })
    answer()
    await expect(pending).resolves.toMatchObject({ kind: 'ready', url })
    expect(initial.createVisualDocument).toHaveBeenCalledWith(expect.stringContaining(html))
    await server.serve({ action: 'release', url })
    expect(initial.releaseVisualDocument).toHaveBeenCalledExactlyOnceWith(url)
    server.dispose()
    expect(initial.releaseVisualDocument).toHaveBeenCalledTimes(1)
  })

  it('does not give a retired page a document after its host read completes', async () => {
    const { server, initial, answer } = fixture()
    const pending = server.serve(params)
    server.dispose()
    answer()
    await expect(pending).rejects.toThrow('unavailable')
    expect(initial.createVisualDocument).not.toHaveBeenCalled()
  })

  it('revokes a late native result on its original view, leaving the replacement untouched', async () => {
    const { server, initial, answer, replace } = fixture()
    let finish = (_value: string) => {}
    let entered = () => {}
    const created = new Promise<void>((resolve) => {
      entered = resolve
    })
    vi.mocked(initial.createVisualDocument).mockImplementation(() => {
      entered()
      return new Promise<string>((resolve) => {
        finish = resolve
      })
    })
    const pending = server.serve(params)
    answer()
    await created
    const next = replace()
    finish(url)
    await expect(pending).rejects.toThrow('changed')
    expect(initial.releaseVisualDocument).toHaveBeenCalledExactlyOnceWith(url)
    expect(next.releaseVisualDocument).not.toHaveBeenCalled()
    server.dispose()
  })

  it('refuses caller-selected paths and never sends report HTML through the page bridge', async () => {
    const { server, client, initial } = fixture()
    await expect(server.serve({ ...params, file: '../other/report.html' })).rejects.toThrow()
    await expect(server.serve({ ...params, html })).rejects.toThrow()
    expect(client.requests).toEqual([])
    expect(initial.createVisualDocument).not.toHaveBeenCalled()
    server.dispose()
  })
})
