import { describe, expect, it } from 'vitest'

import { BrowserClientHostAttachParams } from '../../shared/browser-client-host-protocol'
import { BrowserClientFileChannelTransport } from './browser-client-file-channel-transport'

describe('browser file channel negotiation', () => {
  it('rejects an attach that asks for the file channel without command negotiation', () => {
    expect(
      BrowserClientHostAttachParams.safeParse({
        authorityRuntimeId: 'runtime-1',
        browserHostClientId: 'host-1',
        hostCapabilities: ['webview'],
        fileChannelProtocolVersion: 1
      }).success
    ).toBe(false)
  })

  it('reports the channel unavailable until a negotiated lease binds it', async () => {
    const transport = new BrowserClientFileChannelTransport()
    expect(transport.available).toBe(false)
    expect(transport.availability).toBe('unavailable')
    await expect(transport.request('browser.clientHost.fileChannel.read', {})).rejects.toThrow(
      'browser_client_file_channel_unsupported'
    )

    const sender = {
      fileChannelNegotiated: false,
      fileChannelAvailability: 'unsupported' as const,
      sendFileChannelRequest: async () => ({ ok: true, result: {}, _meta: {} }) as never
    }
    transport.bind(sender)
    expect(transport.available).toBe(false)
    expect(transport.availability).toBe('unsupported')

    const negotiatedSender = {
      fileChannelNegotiated: true,
      fileChannelAvailability: 'negotiated' as const,
      sendFileChannelRequest: async () =>
        ({ ok: true, result: { released: true }, _meta: {} }) as never
    }
    transport.bind(negotiatedSender)
    expect(transport.available).toBe(true)
    expect(transport.availability).toBe('negotiated')
    expect(await transport.request('browser.clientHost.fileChannel.abort', {})).toEqual({
      released: true
    })

    transport.unbind(negotiatedSender)
    expect(transport.available).toBe(false)
    expect(transport.availability).toBe('unavailable')
  })
})
