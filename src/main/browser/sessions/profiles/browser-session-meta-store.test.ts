import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { loadBrowserSessionMeta, persistBrowserSessionMeta } from './browser-session-meta-store'

let directory: string | null = null

afterEach(() => {
  if (directory) {
    rmSync(directory, { recursive: true, force: true })
    directory = null
  }
})

it('keeps a renamed default label across writes that touch other metadata', () => {
  directory = mkdtempSync(join(tmpdir(), 'orca-browser-meta-'))
  const metadataPath = join(directory, 'browser-session-meta.json')
  const resolvePath = (): string => metadataPath

  persistBrowserSessionMeta(resolvePath, 'persist:default', { defaultLabel: 'Work' })
  expect(loadBrowserSessionMeta(resolvePath, 'persist:default').defaultLabel).toBe('Work')

  persistBrowserSessionMeta(resolvePath, 'persist:default', { defaultSource: null })
  expect(loadBrowserSessionMeta(resolvePath, 'persist:default').defaultLabel).toBe('Work')
})
