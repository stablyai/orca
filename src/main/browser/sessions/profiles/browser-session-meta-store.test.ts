import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { persistBrowserSessionMeta } from './browser-session-meta-store'

describe('persistBrowserSessionMeta', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  const metaPath = () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-meta-store-'))
    dirs.push(dir)
    return join(dir, 'meta.json')
  }

  it('leaves a file it cannot read alone, so saved site lists survive', () => {
    const path = metaPath()
    writeFileSync(path, '{"allowedHostsByProfileId": {"p": ["example.com"]}}')
    chmodSync(path, 0o000)
    try {
      persistBrowserSessionMeta(() => path, 'persist:default', { defaultSource: null })
    } finally {
      chmodSync(path, 0o600)
    }
    expect(readFileSync(path, 'utf-8')).toContain('example.com')
  })

  it('overwrites a file that reads but is not valid JSON, as before site lists', () => {
    const path = metaPath()
    writeFileSync(path, '{"allowedHostsByProfileId": {"p": ["example.com"]')
    persistBrowserSessionMeta(() => path, 'persist:default', { defaultSource: null })
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toMatchObject({ allowedHostsByProfileId: {} })
  })

  it('creates the file when it is missing', () => {
    const path = metaPath()
    persistBrowserSessionMeta(() => path, 'persist:default', { defaultSource: null })
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toMatchObject({ allowedHostsByProfileId: {} })
  })
})
