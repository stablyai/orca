import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { SessionSearchIndexStore } from '../storage/session-search-store-types'
import { retireDeletedSessionSearchSources } from './session-search-deleted-sources'
import { SessionSearchDirectoryListings } from './session-search-directory-listings'

let dir: string | null = null

afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true })
  }
  dir = null
})

it("retires a Hermes JSON snapshot row while the file stays on disk, and keeps other agents' files", async () => {
  dir = mkdtempSync(join(tmpdir(), 'orca-search-retire-'))
  const hermesHome = join(dir, '.hermes')
  const jcodeHome = join(dir, '.jcode')
  const snapshot = join(hermesHome, 'sessions', 'session_local-1.json')
  const jcode = join(jcodeHome, 'sessions', 'session_2.json')
  for (const file of [snapshot, jcode]) {
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, '{}')
  }
  const removed: string[] = []
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: retirement only calls removeFile on this store.
  const store = {
    removeFile: (path: string) => removed.push(path)
  } as unknown as SessionSearchIndexStore

  const retirement = await retireDeletedSessionSearchSources({
    store,
    paths: [snapshot, jcode],
    roots: [hermesHome, jcodeHome],
    referenceOnlyRoots: [hermesHome],
    listings: new SessionSearchDirectoryListings()
  })

  expect(removed).toEqual([snapshot])
  expect(retirement.retired).toEqual([snapshot])
})
