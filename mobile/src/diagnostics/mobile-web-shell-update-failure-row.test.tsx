import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MobileWebShellUpdateFailure } from '../mobile-web-shell/mobile-web-shell-update-failure'

/**
 * The row is the only place a release build shows why an update failed, so it reads exactly what
 * was recorded: the newest failure per paired host, and nothing at all until there is one.
 */
type Doubles = {
  failures: MobileWebShellUpdateFailure[]
  hosts: { id: string; name: string }[]
}

const doubles = vi.hoisted((): Doubles => ({ failures: [], hosts: [] }))

vi.mock('react-native', () => ({ Text: 'Text', View: 'View' }))
vi.mock('expo-file-system', () => ({ Directory: class {}, File: class {}, Paths: { cache: '' } }))
vi.mock('../mobile-web-shell/generation-store', () => ({
  createGenerationStore: () => ({ readUpdateFailures: async () => doubles.failures })
}))
vi.mock('../mobile-web-shell/generation-store-file-system', () => ({
  createExpoGenerationFileSystem: () => ({})
}))
vi.mock('../transport/host-store', () => ({ loadHosts: async () => doubles.hosts }))
vi.mock('./troubleshoot-screen-styles', () => ({ troubleshootScreenStyles: {} }))

import { MobileWebShellUpdateFailureRow } from './mobile-web-shell-update-failure-row'

const NOW = Date.UTC(2026, 8, 22, 12, 0, 0)
const OFFERED = `3f2a${'0'.repeat(60)}`
const CACHED = `9e8d${'1'.repeat(60)}`

function failure(overrides: Partial<MobileWebShellUpdateFailure>): MobileWebShellUpdateFailure {
  return {
    hostId: 'host-1',
    at: NOW - 12 * 60_000,
    reason: 'asset-checksum-mismatch',
    hostCode: null,
    offeredBuildId: OFFERED,
    cachedBuildId: CACHED,
    outcome: 'opened-cached',
    wall: null,
    ...overrides
  }
}

async function mountRow(): Promise<ReactTestRenderer> {
  const rendered: { tree: ReactTestRenderer | null } = { tree: null }
  await act(async () => {
    rendered.tree = create(createElement(MobileWebShellUpdateFailureRow))
  })
  if (rendered.tree === null) {
    throw new Error('the row did not mount')
  }
  return rendered.tree
}

function lines(tree: ReactTestRenderer): string[] {
  return tree.root
    .findAll((node) => node.props.testID === 'mobile-web-shell-update-failure')
    .map((node) => [node.props.children].flat().join(''))
}

describe('MobileWebShellUpdateFailureRow', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    doubles.failures = []
    doubles.hosts = [
      { id: 'host-1', name: 'Host 1' },
      { id: 'host-2', name: 'Host 2' }
    ]
  })

  it('renders nothing until a failure has been recorded', async () => {
    const tree = await mountRow()
    expect(tree.toJSON()).toBeNull()
  })

  it('reads the newest recorded failure for a host, with what the shell showed instead', async () => {
    doubles.failures = [
      failure({ at: NOW - 60 * 60_000, reason: 'connection-lost', offeredBuildId: null }),
      failure({})
    ]
    expect(lines(await mountRow())).toEqual([
      'Last update from Host 1 failed 12m ago: asset checksum mismatch (generation 3f2a00000000…).' +
        ' Fell back to the saved version (generation 9e8d11111111…).'
    ])
  })

  it("names the host's own refusal and the wall a cached generation earned", async () => {
    doubles.failures = [
      failure({
        hostId: 'host-2',
        at: NOW - 10_000,
        reason: 'host-refused',
        hostCode: 'mobile_web_bundle_read_limited',
        offeredBuildId: null,
        outcome: 'wall',
        wall: 'bundle-too-old-for-host'
      })
    ]
    expect(lines(await mountRow())).toEqual([
      'Last update from Host 2 failed just now: the host limited concurrent reads.' +
        ' Blocked: the saved bundle is too old for the host.'
    ])
  })

  it('shows one line per paired host and none for a host that is gone', async () => {
    doubles.failures = [
      failure({ hostId: 'host-2', outcome: 'failed', cachedBuildId: null }),
      failure({ hostId: 'removed-host' }),
      failure({ hostId: 'host-1', reason: 'cache-write-failed' })
    ]
    const shown = lines(await mountRow())
    expect(shown).toHaveLength(2)
    expect(shown[0]).toContain('Host 1 failed 12m ago: saving the download on this phone failed')
    expect(shown[1]).toContain('Host 2')
    expect(shown[1]).toContain('Showed the failure screen.')
  })
})
