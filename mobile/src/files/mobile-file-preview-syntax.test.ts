import { describe, expect, it } from 'vitest'
import { buildMobileFilePreviewSyntax } from './mobile-file-preview-syntax'

describe('mobile-file-preview-syntax', () => {
  it('returns syntax segments for supported source paths', () => {
    const syntax = buildMobileFilePreviewSyntax('src/app.ts', 'const answer = 42')

    expect(syntax.language).toBe('typescript')
    expect(syntax.segments.map((segment) => segment.text).join('')).toBe('const answer = 42')
  })

  it('falls back to a plain segment when highlighting is unavailable', () => {
    expect(buildMobileFilePreviewSyntax('README.unknown', 'plain text')).toEqual({
      language: 'plaintext',
      segments: [{ kind: 'plain', text: 'plain text' }]
    })
  })
})
