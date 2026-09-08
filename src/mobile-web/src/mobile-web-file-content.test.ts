import { describe, expect, it } from 'vitest'
import { decodeMobileWebFileContent } from './mobile-web-file-content'

describe('mobile web file content', () => {
  it.each(['line one\nλ line two', '\ufeffline one\r\nλ line two'])(
    'preserves UTF-8 file content: %j',
    (content) => {
      const bytes = new TextEncoder().encode(content)
      const contentBase64 = btoa(String.fromCharCode(...bytes))

      expect(
        decodeMobileWebFileContent({
          workspaceId: 'workspace-1',
          relativePath: 'src/app.ts',
          contentBase64,
          truncated: false,
          byteLength: bytes.byteLength
        })
      ).toEqual({
        workspaceId: 'workspace-1',
        relativePath: 'src/app.ts',
        content,
        truncated: false,
        byteLength: bytes.byteLength
      })
    }
  )
})
