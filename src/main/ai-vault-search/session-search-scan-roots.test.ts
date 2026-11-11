import { expect, it } from 'vitest'
import { delimiter, join } from 'node:path'
import type { SessionFileDiscovery } from '../ai-vault/session-scanner-types'
import { sameSessionSearchRoots, sessionSearchRootListings } from './session-search-scan-roots'

const STATE = '/tmp/ss-roots/openclaw-state'
const LEGACY = '/tmp/ss-roots/openclaw-legacy'

function file(path: string): SessionFileDiscovery['files'][number] {
  return { path, mtimeMs: 0, modifiedAt: new Date(0).toISOString() }
}

it('attributes a file by path segment, not by string prefix', () => {
  const agents = join(STATE, 'agents')
  const legacy = join(LEGACY, 'agents')
  const listings = sessionSearchRootListings(
    { openclawStateDir: STATE, openclawLegacyStateDir: LEGACY },
    [
      {
        agent: 'openclaw',
        rootDir: [agents, legacy].join(delimiter),
        files: [file(join(`${agents}-old`, 'b', 'sessions', 'two.jsonl'))]
      }
    ]
  )

  const byRoot = Object.fromEntries(listings.map((one) => [one.root, one.files]))
  expect(byRoot[agents]).toBe(0)
  expect(byRoot[legacy]).toBe(0)
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
