import { describe, expect, it } from 'vitest'

import { BROWSER_CLIENT_AUTOMATION_HOST_CAPABILITY } from '../../shared/browser-client-automation-protocol'
import { BROWSER_CLIENT_FILE_CHANNEL_HOST_CAPABILITY } from '../../shared/browser-client-file-channel-protocol'
import { assertBrowserHostPageCommandAdmission } from './browser-host-page-command-admission'
import type { BrowserHostLease } from './browser-host-lease-records'

function lease(overrides: Partial<BrowserHostLease> = {}): BrowserHostLease {
  return Object.freeze({
    authorityRuntimeId: 'runtime-1',
    authorityEpoch: 'epoch-1',
    browserHostClientId: 'host-1',
    browserHostGeneration: 1,
    connectionId: 'connection-1',
    pairedDeviceId: 'device-1',
    hostCapabilities: [
      'webview',
      BROWSER_CLIENT_AUTOMATION_HOST_CAPABILITY,
      BROWSER_CLIENT_FILE_CHANNEL_HOST_CAPABILITY
    ],
    pageCommandProtocolVersion: 1 as const,
    fileChannelProtocolVersion: 1 as const,
    ...overrides
  })
}

const uploadCommand = {
  type: 'automation' as const,
  method: 'browser.upload' as const,
  params: { element: '#f', files: ['docs/report.pdf'] }
}

const clickCommand = {
  type: 'automation' as const,
  method: 'browser.click' as const,
  params: { element: '#f' }
}

describe('browser.upload file-channel admission', () => {
  it('admits an upload when both sides negotiated the file channel', () => {
    expect(() =>
      assertBrowserHostPageCommandAdmission(lease(), uploadCommand, () => {})
    ).not.toThrow()
  })

  it('refuses an upload to a client that never advertised the file channel', () => {
    expect(() =>
      assertBrowserHostPageCommandAdmission(
        lease({ hostCapabilities: ['webview', BROWSER_CLIENT_AUTOMATION_HOST_CAPABILITY] }),
        uploadCommand,
        () => {}
      )
    ).toThrow('browser_client_file_channel_unsupported')
  })

  it('refuses an upload when the lease never negotiated the file channel protocol', () => {
    expect(() =>
      assertBrowserHostPageCommandAdmission(
        lease({ fileChannelProtocolVersion: undefined }),
        uploadCommand,
        () => {}
      )
    ).toThrow('browser_client_file_channel_unsupported')
  })

  it('refuses an agent download whose destination path would resolve on the desktop', () => {
    expect(() =>
      assertBrowserHostPageCommandAdmission(
        lease({ fileChannelProtocolVersion: undefined }),
        {
          type: 'automation',
          method: 'browser.download',
          params: { element: '#a', path: '/tmp/x' }
        },
        () => {}
      )
    ).toThrow('browser_client_file_channel_unsupported')
  })

  it('leaves unrelated automation commands unaffected by the file channel', () => {
    expect(() =>
      assertBrowserHostPageCommandAdmission(
        lease({ fileChannelProtocolVersion: undefined }),
        clickCommand,
        () => {}
      )
    ).not.toThrow()
  })
})
