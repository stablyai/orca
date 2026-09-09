import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ userDataDir: '' }))

vi.mock('electron', () => ({
  app: { getPath: () => mocks.userDataDir }
}))

import {
  clientRouteCookieImportSources,
  recordClientRouteCookieImportSource,
  resetClientRouteCookieImportSourcesForTests
} from './client-route-cookie-import-source-store'

const chromeSource = {
  browserFamily: 'chrome' as const,
  profileName: 'Person 1',
  importedAt: 1_000
}

describe('clientRouteCookieImportSources', () => {
  beforeEach(() => {
    mocks.userDataDir = mkdtempSync(join(tmpdir(), 'orca-client-route-sources-'))
    resetClientRouteCookieImportSourcesForTests()
  })
  afterEach(() => {
    rmSync(mocks.userDataDir, { recursive: true, force: true })
  })

  it('keys sources per environment so one import never badges another server', () => {
    recordClientRouteCookieImportSource({
      environmentId: 'env-a',
      profileId: 'default',
      source: chromeSource
    })

    expect(clientRouteCookieImportSources('env-a')).toEqual({ default: chromeSource })
    expect(clientRouteCookieImportSources('env-b')).toEqual({})
  })

  it('survives a process restart', () => {
    recordClientRouteCookieImportSource({
      environmentId: 'env-a',
      profileId: 'default',
      source: chromeSource
    })

    resetClientRouteCookieImportSourcesForTests()
    expect(clientRouteCookieImportSources('env-a')).toEqual({ default: chromeSource })
  })

  it('replaces the source on re-import of the same jar', () => {
    recordClientRouteCookieImportSource({
      environmentId: 'env-a',
      profileId: 'default',
      source: chromeSource
    })
    const edge = { browserFamily: 'edge' as const, importedAt: 2_000 }
    recordClientRouteCookieImportSource({
      environmentId: 'env-a',
      profileId: 'default',
      source: edge
    })

    expect(clientRouteCookieImportSources('env-a')).toEqual({ default: edge })
  })

  it('tolerates a corrupt store file by starting empty', () => {
    recordClientRouteCookieImportSource({
      environmentId: 'env-a',
      profileId: 'default',
      source: chromeSource
    })
    resetClientRouteCookieImportSourcesForTests()
    writeFileSync(join(mocks.userDataDir, 'client-route-cookie-import-sources.json'), '{nope')

    expect(clientRouteCookieImportSources('env-a')).toEqual({})
  })

  it('evicts oldest imports past the cap', () => {
    for (let index = 0; index < 130; index += 1) {
      recordClientRouteCookieImportSource({
        environmentId: `env-${index}`,
        profileId: 'default',
        source: { ...chromeSource, importedAt: index }
      })
    }

    expect(clientRouteCookieImportSources('env-0')).toEqual({})
    expect(clientRouteCookieImportSources('env-129')).toEqual({
      default: { ...chromeSource, importedAt: 129 }
    })
  })
})
