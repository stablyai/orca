import { describe, expect, it } from 'vitest'
import { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'
import { decodeMobileWebFileChunk } from './mobile-web-file-chunk'

describe('mobile web file chunks', () => {
  it('decodes exact binary bytes without text conversion', () => {
    expect(
      decodeMobileWebFileChunk({
        workspaceId: 'workspace-1',
        relativePath: 'data.bin',
        offset: 4,
        contentBase64: 'AAH/',
        bytesRead: 3,
        eof: false
      })
    ).toEqual({
      workspaceId: 'workspace-1',
      relativePath: 'data.bin',
      offset: 4,
      bytes: Uint8Array.from([0, 1, 255]),
      bytesRead: 3,
      eof: false
    })
  })

  it('fails closed when decoded bytes disagree with the envelope', () => {
    expect(() =>
      decodeMobileWebFileChunk({
        workspaceId: 'workspace-1',
        relativePath: 'data.bin',
        offset: 0,
        contentBase64: 'AA==',
        bytesRead: 2,
        eof: true
      })
    ).toThrow(new MobileWebBridgeClientError('invalid_message', false))
  })
})
