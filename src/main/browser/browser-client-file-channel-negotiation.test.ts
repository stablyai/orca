import { describe, expect, it } from 'vitest'

import { BrowserClientHostAttachParams } from '../../shared/browser-client-host-protocol'
import { createBrowserClientHostAttachRequest } from './browser-client-host-attach-request'
import { sameBrowserClientHostLeaseAuthority } from './browser-client-host-command-authority'
import { BrowserClientFileChannelTransport } from './browser-client-file-channel-transport'
import { PairedRuntimeBrowserClientHost } from './paired-runtime-browser-client-host'

const leaseOptions = {
  pairing: {} as never,
  authorityRuntimeId: 'runtime-1',
  browserHostClientId: 'host-1',
  hostCapabilities: ['webview'],
  pageCommandProtocolVersion: 1 as const,
  onPageCommand: () => ({ status: 'completed' }) as never
}

describe('browser file channel negotiation', () => {
  it('requests the file channel only alongside the command protocol', () => {
    expect(
      createBrowserClientHostAttachRequest({
        ...leaseOptions,
        fileChannelProtocolVersion: 1
      }).params.fileChannelProtocolVersion
    ).toBe(1)

    expect(
      createBrowserClientHostAttachRequest({
        ...leaseOptions,
        onPageCommand: undefined,
        fileChannelProtocolVersion: 1
      }).params.fileChannelProtocolVersion
    ).toBeUndefined()
  })

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

  it('keeps the same authority when a reconnect renegotiates the file channel', () => {
    const negotiated = {
      authorityRuntimeId: 'runtime-1',
      authorityEpoch: 'epoch-1',
      browserHostClientId: 'host-1',
      browserHostGeneration: 1,
      pageCommandProtocolVersion: 1 as const,
      fileChannelProtocolVersion: 1 as const
    }

    expect(sameBrowserClientHostLeaseAuthority(negotiated, negotiated)).toBe(true)
    expect(
      sameBrowserClientHostLeaseAuthority(negotiated, {
        ...negotiated,
        fileChannelProtocolVersion: undefined
      })
    ).toBe(true)
    expect(
      sameBrowserClientHostLeaseAuthority(negotiated, {
        ...negotiated,
        browserHostGeneration: 2
      })
    ).toBe(false)
    expect(
      sameBrowserClientHostLeaseAuthority(negotiated, {
        ...negotiated,
        pageCommandProtocolVersion: undefined
      })
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
    // Old host: the caller may keep its local fallback, unlike a lost or unbound channel.
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

  it('separates a host that never offered the channel from one whose lease is gone', () => {
    const host = new PairedRuntimeBrowserClientHost({
      pairing: {} as never,
      authorityRuntimeId: 'runtime-1',
      browserHostClientId: 'host-1',
      hostCapabilities: ['webview'],
      fileChannelProtocolVersion: 1,
      handler: () => Promise.reject(new Error('unused'))
    }) as unknown as {
      closed: boolean
      authority: { fileChannelProtocolVersion?: 1 } | null
      lease: {
        authority: { fileChannelProtocolVersion?: 1 } | null
        fileChannelActive: boolean
      }
      fileChannelAvailability: string
    }

    expect(host.fileChannelAvailability).toBe('unavailable')

    // Old host: it attached, and its authority never named a file channel version.
    host.authority = { fileChannelProtocolVersion: undefined }
    expect(host.fileChannelAvailability).toBe('unsupported')

    host.authority = { fileChannelProtocolVersion: 1 }
    host.lease.authority = { fileChannelProtocolVersion: 1 }
    // Mirror acceptAuthority, the only production writer of lease.authority.
    host.lease.fileChannelActive = true
    expect(host.fileChannelAvailability).toBe('negotiated')

    host.closed = true
    expect(host.fileChannelAvailability).toBe('unavailable')
  })
})
