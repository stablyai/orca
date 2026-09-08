import { describe, expect, it } from 'vitest'
import { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'
import { decodeMobileWebFileChunk } from './mobile-web-file-chunk'

const payload = {
  workspaceId: 'workspace-1',
  relativePath: 'data.bin',
  offset: 4,
  length: 8
}

describe('mobile web file chunks', () => {
  it('decodes exact binary bytes without text conversion', () => {
    expect(
      decodeMobileWebFileChunk({ contentBase64: 'AAH/', bytesRead: 3, eof: false }, payload)
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
      decodeMobileWebFileChunk({ contentBase64: 'AA==', bytesRead: 2, eof: true }, payload)
    ).toThrow(new MobileWebBridgeClientError('invalid_message', false))
  })

  it('refuses a chunk longer than the page asked for', () => {
    expect(() =>
      decodeMobileWebFileChunk({ contentBase64: 'AAECAwQFBgcI', bytesRead: 9, eof: true }, payload)
    ).toThrow(new MobileWebBridgeClientError('invalid_message', false))
  })

  it('ignores fields a newer desktop adds', () => {
    expect(
      decodeMobileWebFileChunk(
        { contentBase64: 'AAH/', bytesRead: 3, eof: false, worktree: 'private', futureField: 1 },
        payload
      ).bytesRead
    ).toBe(3)
  })
})
