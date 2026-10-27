import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteRuntimeClientError } from '../../shared/remote-runtime/remote-runtime-client-error'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'
import {
  BrowserClientPageMetadataTransport,
  publishBrowserClientPageMetadata,
  registerBrowserClientPageMetadataTransport,
  resetBrowserClientPageMetadataTransports
} from './browser-client-page-metadata-transport'

const PARAMS = {
  browserHostClientId: 'host-a',
  browserHostGeneration: 3,
  browserPageId: 'page-a',
  pageHostGeneration: 7,
  revision: 2,
  url: 'https://example.internal/moved',
  title: 'Moved',
  loading: false,
  canGoBack: true,
  canGoForward: false
}

function answered(result: unknown): RuntimeRpcResponse<unknown> {
  return { id: 'page-metadata-a', ok: true, result, _meta: { runtimeId: 'runtime-a' } }
}

function refused(code: string, message: string): RuntimeRpcResponse<unknown> {
  return { id: 'page-metadata-a', ok: false, error: { code, message } }
}

afterEach(() => {
  resetBrowserClientPageMetadataTransports()
})

describe('browser client page metadata transport', () => {
  it('rejects a runtime error and an unreadable acknowledgement', async () => {
    const failing = new BrowserClientPageMetadataTransport()
    failing.bind({
      sendPageMetadataRequest: () => Promise.resolve(refused('browser_host_lease_stale', 'stale'))
    })
    await expect(failing.publish(PARAMS)).rejects.toThrow('stale')

    const garbled = new BrowserClientPageMetadataTransport()
    garbled.bind({
      sendPageMetadataRequest: () => Promise.resolve(answered({ accepted: 'yes' }))
    })
    await expect(garbled.publish(PARAMS)).rejects.toThrow(
      'browser_client_page_metadata_ack_invalid'
    )
  })

  it('refuses to publish once nothing is bound', async () => {
    const transport = new BrowserClientPageMetadataTransport()
    const sender = { sendPageMetadataRequest: vi.fn() }
    transport.bind(sender)
    transport.unbind(sender)

    await expect(transport.publish(PARAMS)).rejects.toBeInstanceOf(RemoteRuntimeClientError)
    expect(sender.sendPageMetadataRequest).not.toHaveBeenCalled()
  })

  it('leaves a replacement bound when the host it replaced unbinds', async () => {
    const transport = new BrowserClientPageMetadataTransport()
    const outgoing = { sendPageMetadataRequest: vi.fn() }
    const replacement = {
      sendPageMetadataRequest: vi.fn().mockResolvedValue(answered({ accepted: true }))
    }
    transport.bind(outgoing)
    transport.bind(replacement)
    transport.unbind(outgoing)

    await expect(transport.publish(PARAMS)).resolves.toEqual({ accepted: true })
    expect(replacement.sendPageMetadataRequest).toHaveBeenCalledTimes(1)
  })
})

describe('browser client page metadata routing', () => {
  it('publishes through the transport of the environment that owns the page', async () => {
    const owning = new BrowserClientPageMetadataTransport()
    const other = new BrowserClientPageMetadataTransport()
    const owningSend = vi.fn().mockResolvedValue(answered({ accepted: true }))
    const otherSend = vi.fn()
    owning.bind({ sendPageMetadataRequest: owningSend })
    other.bind({ sendPageMetadataRequest: otherSend })
    registerBrowserClientPageMetadataTransport('environment-a', owning)
    registerBrowserClientPageMetadataTransport('environment-b', other)

    await expect(publishBrowserClientPageMetadata('environment-a', PARAMS)).resolves.toEqual({
      accepted: true
    })
    expect(otherSend).not.toHaveBeenCalled()
  })

  // Another environment detects accidental fallback to any registered transport.
  it('fails a publish for an environment that hosts nothing while another one does', async () => {
    const elsewhere = new BrowserClientPageMetadataTransport()
    const elsewhereSend = vi.fn()
    elsewhere.bind({ sendPageMetadataRequest: elsewhereSend })
    registerBrowserClientPageMetadataTransport('environment-b', elsewhere)

    await expect(publishBrowserClientPageMetadata('environment-a', PARAMS)).rejects.toBeInstanceOf(
      RemoteRuntimeClientError
    )
    expect(elsewhereSend).not.toHaveBeenCalled()
  })

  it('stops routing to a released transport without disturbing a re-registered one', async () => {
    const first = new BrowserClientPageMetadataTransport()
    const release = registerBrowserClientPageMetadataTransport('environment-a', first)
    const second = new BrowserClientPageMetadataTransport()
    second.bind({
      sendPageMetadataRequest: () => Promise.resolve(answered({ accepted: true }))
    })
    registerBrowserClientPageMetadataTransport('environment-a', second)

    release()

    await expect(publishBrowserClientPageMetadata('environment-a', PARAMS)).resolves.toEqual({
      accepted: true
    })
  })
})
