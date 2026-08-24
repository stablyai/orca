import { describe, expect, it } from 'vitest'
import { classifyMobileArtifact, isMobileBinaryPreviewPath } from './mobile-artifact-kind'

describe('classifyMobileArtifact', () => {
  it('classifies raster image extensions (case-insensitive)', () => {
    for (const p of ['a.png', 'b.JPG', 'c/d.jpeg', 'e.gif', 'f.webp', 'g.bmp', 'h.ico']) {
      expect(classifyMobileArtifact(p)).toBe('image')
    }
  })

  it('treats svg as other (RN Image cannot decode svg data URIs; render as source)', () => {
    expect(classifyMobileArtifact('logo.svg')).toBe('other')
  })

  it('classifies natively playable video extensions (case-insensitive)', () => {
    for (const p of ['clip.mp4', 'a/b/demo.MOV', 'c.m4v']) {
      expect(classifyMobileArtifact(p)).toBe('video')
    }
  })

  it('treats webm/mkv as other (iOS cannot decode them)', () => {
    expect(classifyMobileArtifact('clip.webm')).toBe('other')
    expect(classifyMobileArtifact('clip.mkv')).toBe('other')
  })

  it('routes images and videos to the base64 preview reads', () => {
    expect(isMobileBinaryPreviewPath('assets/logo.png')).toBe(true)
    expect(isMobileBinaryPreviewPath('assets/demo.mp4')).toBe(true)
    expect(isMobileBinaryPreviewPath('index.html')).toBe(false)
    expect(isMobileBinaryPreviewPath('src/app.ts')).toBe(false)
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
