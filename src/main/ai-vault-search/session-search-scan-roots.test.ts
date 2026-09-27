import { expect, it } from 'vitest'
import { delimiter, join } from 'node:path'
import type { SessionFileDiscovery } from '../ai-vault/session-scanner-types'
import { sameSessionSearchRoots, sessionSearchRootListings } from './session-search-scan-roots'

const STATE = '/tmp/ss-roots/openclaw-state'
const LEGACY = '/tmp/ss-roots/openclaw-legacy'

function file(path: string): SessionFileDiscovery['files'][number] {
  return { path, mtimeMs: 0, modifiedAt: new Date(0).toISOString() }
}

it('splits a merged discovery into the real directories behind it', () => {
  const current = join(STATE, 'agents')
  const legacy = join(LEGACY, 'agents')
  const listings = sessionSearchRootListings(
    { openclawStateDir: STATE, openclawLegacyStateDir: LEGACY },
    [
      {
        agent: 'openclaw',
        // What discovery reports for an agent whose roots are alternates.
        rootDir: [current, legacy].join(delimiter),
        files: [
          file(join(current, 'a', 'sessions', 'one.jsonl')),
          file(join(current, 'a', 'sessions', 'two.jsonl')),
          file(join(legacy, 'b', 'sessions', 'three.jsonl'))
        ]
      }
    ]
  )

  const byRoot = Object.fromEntries(listings.map((one) => [one.root, one.files]))
  expect(byRoot[current]).toBe(2)
  expect(byRoot[legacy]).toBe(1)
  // The joined string is never reported as a directory.
  expect(listings.every((one) => !one.root.includes(delimiter))).toBe(true)
})

it('attributes a file by path segment, not by string prefix', () => {
  const agents = join(STATE, 'agents')
  const legacy = join(LEGACY, 'agents')
  const listings = sessionSearchRootListings(
    { openclawStateDir: STATE, openclawLegacyStateDir: LEGACY },
    [
      {
        agent: 'openclaw',
        rootDir: [agents, legacy].join(delimiter),
        // A sibling directory whose name merely starts with a root's name. It
        // is under no root, so it belongs to none of them.
        files: [file(join(`${agents}-old`, 'b', 'sessions', 'two.jsonl'))]
      }
    ]
  )

  const byRoot = Object.fromEntries(listings.map((one) => [one.root, one.files]))
  expect(byRoot[agents]).toBe(0)
  expect(byRoot[legacy]).toBe(0)
})

it('reads a re-resolved root set as the same trees when only spelling order differs', () => {
  expect(
    sameSessionSearchRoots(
      { openclawStateDir: STATE, wslHomeDirs: ['/home/a', '/home/b'] },
      { wslHomeDirs: ['/home/b', '/home/a'], openclawStateDir: STATE }
    )
  ).toBe(true)
  // An absent key and an explicitly undefined one are the same absence.
  expect(sameSessionSearchRoots({ openclawStateDir: STATE }, { openclawStateDir: STATE })).toBe(
    true
  )
})

it('reads an added, dropped or changed root as a different set', () => {
  const base = { openclawStateDir: STATE, wslHomeDirs: ['/home/a'] }
  expect(sameSessionSearchRoots(base, { ...base, openclawLegacyStateDir: LEGACY })).toBe(false)
  expect(sameSessionSearchRoots(base, { openclawStateDir: STATE })).toBe(false)
  expect(sameSessionSearchRoots(base, { ...base, wslHomeDirs: ['/home/b'] })).toBe(false)
})

it('compares WSL readers structurally without restarting for reordered objects', () => {
  const ubuntu = { distro: 'Ubuntu', executable: '/usr/bin/node', readerPath: '/reader.cjs' }
  const debian = { distro: 'Debian', error: 'Preparing' }
  expect(
    sameSessionSearchRoots(
      { wslOpenCodeReaders: [ubuntu, debian] },
      {
        wslOpenCodeReaders: [
          { error: 'Preparing', distro: 'debian' },
          { readerPath: '/reader.cjs', executable: '/usr/bin/node', distro: 'ubuntu' }
        ]
      }
    )
  ).toBe(true)
  expect(sameSessionSearchRoots({}, { wslOpenCodeReaders: [] })).toBe(true)
  expect(
    sameSessionSearchRoots(
      { wslOpenCodeReaders: [ubuntu] },
      { wslOpenCodeReaders: [{ ...ubuntu, executable: '/new/node' }] }
    )
  ).toBe(false)
})
