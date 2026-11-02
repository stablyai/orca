import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  forgetBrowserSessionProfileMeta,
  loadBrowserSessionMeta,
  persistBrowserSessionMeta
} from './browser-session-meta-store'

const DEFAULT_PARTITION = 'persist:orca-browser'
let root: string
const metaPath = (): string => join(root, 'browser-session-meta.json')

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-browser-meta-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('per-profile enabled extensions in browser session meta', () => {
  it('survive unrelated metadata writes', () => {
    persistBrowserSessionMeta(metaPath, DEFAULT_PARTITION, {
      enabledExtensionIdsByProfileId: { default: ['ext-a'], work: ['ext-b'] }
    })
    persistBrowserSessionMeta(metaPath, DEFAULT_PARTITION, { defaultSource: null })
    expect(
      loadBrowserSessionMeta(metaPath, DEFAULT_PARTITION).enabledExtensionIdsByProfileId
    ).toEqual({
      default: ['ext-a'],
      work: ['ext-b']
    })
  })

  it('are dropped with a deleted profile, leaving other profiles alone', () => {
    persistBrowserSessionMeta(metaPath, DEFAULT_PARTITION, {
      enabledExtensionIdsByProfileId: { default: ['ext-a'], work: ['ext-b'] },
      pendingCookieImports: { 'persist:work': '/tmp/staged.db' }
    })
    const meta = loadBrowserSessionMeta(metaPath, DEFAULT_PARTITION)
    persistBrowserSessionMeta(
      metaPath,
      DEFAULT_PARTITION,
      forgetBrowserSessionProfileMeta(
        meta,
        { id: 'work', partition: 'persist:work' },
        DEFAULT_PARTITION
      )
    )
    const after = loadBrowserSessionMeta(metaPath, DEFAULT_PARTITION)
    expect(after.enabledExtensionIdsByProfileId).toEqual({ default: ['ext-a'] })
    expect(after.pendingCookieImports).toEqual({})
  })
})

describe('per-profile pinned toolbar extensions in browser session meta', () => {
  it('keep pin order across writes and drop only the deleted profile', () => {
    persistBrowserSessionMeta(metaPath, DEFAULT_PARTITION, {
      pinnedExtensionIdsByProfileId: { default: ['ext-b', 'ext-a'], work: ['ext-c'] }
    })
    persistBrowserSessionMeta(metaPath, DEFAULT_PARTITION, {
      enabledExtensionIdsByProfileId: { default: ['ext-a', 'ext-b'] }
    })
    const meta = loadBrowserSessionMeta(metaPath, DEFAULT_PARTITION)
    expect(meta.pinnedExtensionIdsByProfileId.default).toEqual(['ext-b', 'ext-a'])
    persistBrowserSessionMeta(
      metaPath,
      DEFAULT_PARTITION,
      forgetBrowserSessionProfileMeta(
        meta,
        { id: 'work', partition: 'persist:work' },
        DEFAULT_PARTITION
      )
    )
    expect(
      loadBrowserSessionMeta(metaPath, DEFAULT_PARTITION).pinnedExtensionIdsByProfileId
    ).toEqual({ default: ['ext-b', 'ext-a'] })
  })
})
