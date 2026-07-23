import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  _getAttributionWrittenRootCountForTests,
  _isAttributionWrittenRootRetainableForTests,
  _resetAttributionWrittenRootsForTests,
  applyTerminalAttributionEnv,
  ATTRIBUTION_WRITTEN_ROOT_MAX_BYTES,
  ATTRIBUTION_WRITTEN_ROOT_MAX_ENTRIES
} from './terminal-attribution'

let fixtureRoot: string | null = null

afterEach(() => {
  _resetAttributionWrittenRootsForTests()
  if (fixtureRoot) {
    rmSync(fixtureRoot, { recursive: true, force: true })
    fixtureRoot = null
  }
})

describe('terminal attribution root retention', () => {
  it('bounds successfully ensured roots', () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'orca-attribution-roots-'))
    for (let index = 0; index <= ATTRIBUTION_WRITTEN_ROOT_MAX_ENTRIES; index += 1) {
      applyTerminalAttributionEnv(
        { PATH: process.env.PATH ?? '' },
        { enabled: true, userDataPath: join(fixtureRoot, String(index)) }
      )
    }
    expect(_getAttributionWrittenRootCountForTests()).toBe(ATTRIBUTION_WRITTEN_ROOT_MAX_ENTRIES)
  })

  it('measures retained roots by UTF-8 bytes', () => {
    expect(
      _isAttributionWrittenRootRetainableForTests('x'.repeat(ATTRIBUTION_WRITTEN_ROOT_MAX_BYTES))
    ).toBe(true)
    expect(
      _isAttributionWrittenRootRetainableForTests(
        '😀'.repeat(ATTRIBUTION_WRITTEN_ROOT_MAX_BYTES / 4 + 1)
      )
    ).toBe(false)
  })
})
