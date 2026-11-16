import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { collectProtectedCopyKeys, main, PROTECTED_COPY_KEYS_PATH } from './protected-copy-keys.mjs'

const ENGLISH = new Set(['trust.title', 'trust.reasons.network'])

let dirs = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true })
  }
  dirs = []
})

function sourcesFrom(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'orca-protected-copy-'))
  dirs.push(root)
  const sources = new Map()
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(root, ...name.split('/'))
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, text)
    sources.set(file, text)
  }
  return sources
}

describe('collectProtectedCopyKeys', () => {
  it('keeps dynamic key heads only when they are specific', () => {
    const sources = sourcesFrom({
      'Dialog.tsx': '<SecuritySurface>{translate(`trust.${id}`)}{translate(`trust.reasons.${x}`)}'
    })

    expect(collectProtectedCopyKeys(sources, ENGLISH).prefixes).toEqual(['trust.reasons.'])
  })
})

describe('protected copy check', () => {
  it('fails when a security dialog uses a key the generated list lacks, until synced', async () => {
    sourcesFrom({
      'src/renderer/src/i18n/locales/en.json': JSON.stringify({ trust: { allow: 'Allow' } }),
      'src/renderer/src/Dialog.tsx': `<SecuritySurface>{translate('trust.allow', 'Allow')}`,
      'src/main/ready.ts': '',
      [PROTECTED_COPY_KEYS_PATH.split(path.sep).join('/')]: '{}'
    })
    const root = dirs.at(-1)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})

    expect(await main(root, [])).toBe(1)
    expect(await main(root, ['--fix'])).toBe(0)
    expect(await main(root, [])).toBe(0)
    expect(JSON.parse(readFileSync(path.join(root, PROTECTED_COPY_KEYS_PATH), 'utf8'))).toEqual({
      keys: ['trust.allow'],
      prefixes: []
    })
  })
})
