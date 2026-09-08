import { describe, expect, it } from 'vitest'
import { boundMobileWebFileContent } from './mobile-web-file-content'
import { MOBILE_WEB_FILE_CONTENT_MAX_BYTES } from '../../../../shared/mobile-web/file-operation-contract'

describe('bounded mobile file text', () => {
  it.each(['x'.repeat(300 * 1024), '🌍'.repeat(100_000), '\u0001'.repeat(300 * 1024)])(
    'preserves a text preview below decoded and encoded bridge ceilings %#',
    (content) => {
      const result = boundMobileWebFileContent({
        relativePath: 'large.txt',
        content,
        byteLength: Buffer.byteLength(content),
        truncated: false
      })
      expect(result.truncated).toBe(true)
      expect(Buffer.byteLength(result.content as string)).toBeLessThanOrEqual(
        MOBILE_WEB_FILE_CONTENT_MAX_BYTES
      )
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(512 * 1024)
      expect(content.startsWith(result.content as string)).toBe(true)
      expect(result.byteLength).toBe(Buffer.byteLength(content))
    }
  )
  it('leaves bounded content and future metadata intact', () => {
    const result = {
      relativePath: 'small.txt',
      content: '\uFEFF🌍',
      byteLength: 7,
      truncated: false,
      futureField: true
    }
    expect(boundMobileWebFileContent(result)).toEqual(result)
  })
})
