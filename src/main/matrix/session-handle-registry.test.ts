import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  handleForPaneKey,
  paneKeyForHandle,
  registerSessionHandle
} from './session-handle-registry'

describe('session-handle-registry', () => {
  let tempHome: string
  let originalHome: string | undefined

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'orca-matrix-handles-'))
    originalHome = process.env.HOME
    process.env.HOME = tempHome
  })

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME
    } else {
      process.env.HOME = originalHome
    }
    rmSync(tempHome, { recursive: true, force: true })
  })

  it('mints a short handle and resolves it back to the pane key', () => {
    const paneKey = 'tab-123:leaf-abc'
    const handle = handleForPaneKey(paneKey)
    expect(handle.length).toBeGreaterThanOrEqual(4)
    expect(handle).toMatch(/^[0-9a-z]+$/)
    expect(paneKeyForHandle(handle)).toBe(paneKey)
  })

  it('is stable: the same pane key returns the same handle', () => {
    const paneKey = 'tab-x:leaf-y'
    expect(handleForPaneKey(paneKey)).toBe(handleForPaneKey(paneKey))
  })

  it('resolves handles case-insensitively', () => {
    const handle = handleForPaneKey('tab-c:leaf-d')
    expect(paneKeyForHandle(handle.toUpperCase())).toBe('tab-c:leaf-d')
  })

  it('assigns distinct handles to distinct pane keys', () => {
    const a = handleForPaneKey('tab-1:leaf-1')
    const b = handleForPaneKey('tab-2:leaf-2')
    expect(a).not.toBe(b)
  })

  it('persists across registry reloads', () => {
    const paneKey = 'tab-persist:leaf-persist'
    const handle = handleForPaneKey(paneKey)
    // A fresh call reads the persisted file rather than re-minting.
    expect(paneKeyForHandle(handle)).toBe(paneKey)
  })

  it('returns null for an unknown handle', () => {
    expect(paneKeyForHandle('zzzz')).toBeNull()
  })

  it('treats Object.prototype member names as ordinary unknown handles', () => {
    // Without a null-proto map, byHandle['toString'] would read the inherited
    // function (truthy) and paneKeyForHandle would return it instead of null.
    expect(paneKeyForHandle('toString')).toBeNull()
    expect(paneKeyForHandle('constructor')).toBeNull()
  })

  it('mints a clean handle for a label that spells a prototype member', () => {
    const handle = registerSessionHandle('tab-proto:leaf', 'constructor')
    expect(handle).toBe('constructor')
    expect(paneKeyForHandle('constructor')).toBe('tab-proto:leaf')
  })

  describe('registerSessionHandle', () => {
    it('mints a speaking handle from a label and resolves it back', () => {
      const paneKey = 'tab-a:leaf-a'
      const handle = registerSessionHandle(paneKey, 'feat/matrix-adapter')
      expect(handle).toBe('feat-matrix-adapter')
      expect(paneKeyForHandle('@feat-matrix-adapter'.slice(1))).toBe(paneKey)
    })

    it('caps an overlong label and trims trailing dashes', () => {
      const handle = registerSessionHandle(
        'tab-b:leaf-b',
        'a-really-long-branch-name-that-keeps-going'
      )
      expect(handle.length).toBeLessThanOrEqual(24)
      expect(handle.endsWith('-')).toBe(false)
    })

    it('disambiguates two sessions that share a label with a numeric suffix', () => {
      const first = registerSessionHandle('tab-1:leaf-1', 'main')
      const second = registerSessionHandle('tab-2:leaf-2', 'main')
      expect(first).toBe('main')
      expect(second).toBe('main-2')
      expect(paneKeyForHandle('main')).toBe('tab-1:leaf-1')
      expect(paneKeyForHandle('main-2')).toBe('tab-2:leaf-2')
    })

    it('keeps a disambiguated handle within the length cap', () => {
      const label = 'a-really-long-branch-name-that-keeps-going'
      const first = registerSessionHandle('tab-x1:leaf', label)
      const second = registerSessionHandle('tab-x2:leaf', label)
      expect(second).not.toBe(first)
      expect(second.length).toBeLessThanOrEqual(24)
      expect(second).toMatch(/-\d+$/)
    })

    it('falls back to the deterministic slug when the label yields nothing usable', () => {
      const handle = registerSessionHandle('tab-c:leaf-c', '///')
      expect(handle).toMatch(/^[0-9a-z]+$/)
      expect(handle.length).toBeGreaterThanOrEqual(4)
    })

    it('falls back to the deterministic slug when no label is given', () => {
      const handle = registerSessionHandle('tab-d:leaf-d')
      expect(handle).toMatch(/^[0-9a-z]+$/)
    })

    it('is stable: an already-named session keeps its handle even with a new label', () => {
      const paneKey = 'tab-e:leaf-e'
      const first = registerSessionHandle(paneKey, 'main')
      const second = registerSessionHandle(paneKey, 'a-different-branch')
      expect(second).toBe(first)
    })
  })
})
