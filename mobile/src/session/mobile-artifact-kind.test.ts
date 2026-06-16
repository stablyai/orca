import { describe, expect, it } from 'vitest'
import { classifyMobileArtifact } from './mobile-artifact-kind'

describe('classifyMobileArtifact', () => {
  it('classifies raster image extensions (case-insensitive)', () => {
    for (const p of ['a.png', 'b.JPG', 'c/d.jpeg', 'e.gif', 'f.webp', 'g.bmp', 'h.ico']) {
      expect(classifyMobileArtifact(p)).toBe('image')
    }
  })

  it('treats svg as other (RN Image cannot decode svg data URIs; render as source)', () => {
    expect(classifyMobileArtifact('logo.svg')).toBe('other')
  })

  it('classifies html extensions', () => {
    expect(classifyMobileArtifact('index.html')).toBe('html')
    expect(classifyMobileArtifact('a/b/page.HTM')).toBe('html')
  })

  it('treats code/text/unknown as other', () => {
    for (const p of ['main.ts', 'README.md', 'data.csv', 'notes', 'a.pdf', 'x.json']) {
      expect(classifyMobileArtifact(p)).toBe('other')
    }
  })

  it('treats a dotfile or no-extension path as other', () => {
    expect(classifyMobileArtifact('.gitignore')).toBe('other')
    expect(classifyMobileArtifact('Makefile')).toBe('other')
    expect(classifyMobileArtifact('dir/.env')).toBe('other')
  })
})
