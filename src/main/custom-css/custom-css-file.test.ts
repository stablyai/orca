import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CUSTOM_CSS_MAX_BYTES } from '../../shared/custom-css'
import { ensureCustomCssFile, getUserCustomCssPath, readCustomCssFile } from './custom-css-file'

describe('custom-css-file', () => {
  let home: string
  let path: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'orca-custom-css-'))
    path = getUserCustomCssPath(home)
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  it('reports a missing file without an error', () => {
    expect(readCustomCssFile(path)).toEqual({ path, exists: false, css: '', error: null })
  })

  it('creates the folder and a commented template that changes nothing', () => {
    ensureCustomCssFile(path)
    const css = readFileSync(path, 'utf8')
    expect(css).toContain('--background')
    // Every declaration in the template is commented out.
    expect(css.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/--[a-z-]+\s*:/)
  })

  it('never overwrites an existing file', () => {
    ensureCustomCssFile(path)
    writeFileSync(path, ':root { --background: #123456; }')
    ensureCustomCssFile(path)
    expect(readCustomCssFile(path).css).toBe(':root { --background: #123456; }')
  })

  it('refuses files over the size limit', () => {
    ensureCustomCssFile(path)
    writeFileSync(path, 'a'.repeat(CUSTOM_CSS_MAX_BYTES + 1))
    const snapshot = readCustomCssFile(path)
    expect(snapshot.css).toBe('')
    expect(snapshot.error).toEqual({ kind: 'too-large', sizeBytes: CUSTOM_CSS_MAX_BYTES + 1 })
  })
})
