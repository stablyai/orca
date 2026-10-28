import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  KnownRuntimeEnvironment,
  OrcadDeploymentLink
} from '../../../shared/runtime-environments'
import {
  emptyWslMoveBrowserCookieCopyCounts,
  WSL_MOVE_BROWSER_COOKIES_STORE_ID
} from '../../../shared/wsl-move/wsl-move-browser-cookie-copy'
import { WSL_HOSTS_INTERNAL_GATE_ENV } from '../../../shared/wsl-host-internal-gate'
import { parseWslMoveCutover } from '../../../shared/wsl-move/wsl-move-cutover'
import { wslMoveCutoverFixture as cutover } from '../__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { seedWslMoveCutover } from '../__fixtures__/wsl-mover/wsl-move-journal-seeding'
import { deriveBrowserRoutePartitionStorageScope } from '../../browser/browser-route-identity'
import { wslHostBrowserRouteStorage } from '../../browser/wsl-host-browser-route-partition'
import { listWslMoveCutovers } from './wsl-move-cutover-journal'
import type { WslMoveBrowserCookieCopyDependencies } from './wsl-move-browser-cookie-copy'
import { previewWslMoveBrowserCookieCopy } from './wsl-move-browser-cookie-copy'
import { registerWslMoveBrowserCookieStore } from './wsl-move-browser-cookie-store'
import {
  runGatedWslMoveDesktopRewritePass,
  runWslMoveDesktopRewritePass
} from './wsl-move-desktop-rewrite'
import {
  resetWslMoveDesktopRewriteStoresForTests,
  setWslMoveDesktopRewriteRegistryCompleteForTests
} from './wsl-move-desktop-rewrite-stores'

vi.mock('../../browser/browser-partition-cookie-copy', () => ({
  copyBrowserPartitionCookies: vi.fn(),
  flushBrowserPartitionCookies: vi.fn()
}))
vi.mock('../../browser/browser-session-registry', () => ({ browserSessionRegistry: {} }))
vi.mock('../../browser/browser-session-startup', () => ({ browserSessionsInitialized: vi.fn() }))
vi.mock('../../browser/browser-route-partition-binding-runtime', () => ({
  activeBrowserRoutePartitionOrcaProfileId: vi.fn(),
  currentBrowserRoutePartitionBindingStore: vi.fn()
}))
vi.mock('../../browser/browser-route-partition-storage-dependencies', () => ({
  releaseEvictedBrowserRoutePartitionStorage: vi.fn()
}))

const LOCAL_DEFAULT = 'persist:orca-browser-default'
const LOCAL_WORK = 'persist:orca-browser-work'
const SSH_PARTITION = `persist:orca-browser-v1-${'5'.repeat(64)}`

type Jar = Map<string, string>

/** One desktop: its partitions' cookie jars, its environments, and what touched them. */
type Desktop = {
  jars: Map<string, Jar>
  environments: KnownRuntimeEnvironment[]
  sessionsReady: boolean
  copies: { source: string; destination: string }[]
  flushed: string[]
  failFlush: boolean
}

let userDataPath: string
let desktop: Desktop

function jarOf(partition: string): Jar {
  let jar = desktop.jars.get(partition)
  if (!jar) {
    jar = new Map()
    desktop.jars.set(partition, jar)
  }
  return jar
}

function hostPartition(storageScope: string, browserProfileId: string): string {
  const digest = createHash('sha256').update(`${storageScope}|${browserProfileId}`).digest('hex')
  return `persist:orca-browser-v1-${digest}`
}

/** The moved-to WSL host's partition for one browser profile. */
function hostPartitionOf(browserProfileId: string): string {
  const scope = deriveBrowserRoutePartitionStorageScope({
    orcaProfileId: 'orca-profile-a',
    environmentId: 'wsl:Ubuntu'
  })
  return hostPartition(scope, browserProfileId)
}

function dependencies(
  overrides: Partial<WslMoveBrowserCookieCopyDependencies> = {}
): WslMoveBrowserCookieCopyDependencies {
  return {
    userDataPath,
    sessionsReady: () => desktop.sessionsReady,
    orcaProfileId: () => 'orca-profile-a',
    listEnvironments: () => desktop.environments,
    listBrowserProfiles: () => [
      { id: 'default', partition: LOCAL_DEFAULT },
      { id: 'work', partition: LOCAL_WORK }
    ],
    resolveHostStorage: wslHostBrowserRouteStorage,
    bindHostPartition: (storage, browserProfileId) =>
      hostPartition(storage.storageScope, browserProfileId),
    copyCookies: async (source, destination) => {
      desktop.copies.push({ source, destination })
      const counts = emptyWslMoveBrowserCookieCopyCounts()
      const target = jarOf(destination)
      for (const [name, value] of jarOf(source)) {
        if (target.has(name)) {
          counts.skippedPresent += 1
        } else {
          target.set(name, value)
          counts.copied += 1
        }
      }
      return counts
    },
    flushCookies: async (partition) => {
      if (desktop.failFlush) {
        throw new Error('crashed before the ledger entry')
      }
      desktop.flushed.push(partition)
    },
    ...overrides
  }
}

const DEPLOYMENTS = {
  wsl: { kind: 'wsl', distro: 'Ubuntu', localPort: 41_001, remotePort: 6768 },
  'managed-ssh': {
    sshTargetId: 'target-a',
    sshTargetGeneration: 1,
    localPort: 41_001,
    remotePort: 6768
  },
  unlinked: null
} satisfies Record<string, OrcadDeploymentLink | null>

/** A runtime environment as each host kind persists it; `unlinked` lost its deployment link. */
function hostEnvironment(kind: keyof typeof DEPLOYMENTS, id: string): KnownRuntimeEnvironment {
  const deployment = DEPLOYMENTS[kind]
  return {
    id,
    name: id,
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
    runtimeId: null,
    pairingRevision: 1,
    ...(deployment ? { orcadDeployment: deployment } : {}),
    preferredEndpointId: 'endpoint-a',
    endpoints: [
      {
        id: 'endpoint-a',
        kind: 'websocket',
        label: id,
        endpoint: 'ws://127.0.0.1:41001',
        deviceToken: 'token-a',
        publicKeyB64: 'host-key-a'
      }
    ]
  }
}

const wslHost = (kind: 'wsl' | 'unlinked' = 'wsl'): KnownRuntimeEnvironment =>
  hostEnvironment(kind, 'wsl:Ubuntu')
const record = (migrationId = 'move-1') =>
  listWslMoveCutovers(userDataPath).find((entry) => entry.migrationId === migrationId)

beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'wsl-move-browser-cookies-'))
  vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '1')
  setWslMoveDesktopRewriteRegistryCompleteForTests(true)
  desktop = {
    jars: new Map(),
    environments: [
      wslHost(),
      hostEnvironment('managed-ssh', 'ssh-managed'),
      // Plain SSH and manually paired servers carry no deployment link.
      hostEnvironment('unlinked', 'ssh-plain'),
      hostEnvironment('unlinked', 'paired')
    ],
    sessionsReady: true,
    copies: [],
    flushed: [],
    failFlush: false
  }
  jarOf(LOCAL_DEFAULT).set('sid', 'desktop-login')
  jarOf(LOCAL_WORK).set('work-sid', 'work-login')
  jarOf(SSH_PARTITION).set('ssh-sid', 'ssh-login')
})
afterEach(() => {
  vi.unstubAllEnvs()
  resetWslMoveDesktopRewriteStoresForTests()
  rmSync(userDataPath, { recursive: true, force: true })
})

function snapshot(partitions: readonly string[]): Record<string, [string, string][]> {
  return Object.fromEntries(partitions.map((partition) => [partition, [...jarOf(partition)]]))
}

describe('WSL move browser-cookies store', () => {
  it('copies every browser profile into the WSL host partition and records it', async () => {
    registerWslMoveBrowserCookieStore(dependencies())
    seedWslMoveCutover(userDataPath, cutover('move-1', 'destination-committed'))
    const untouched = snapshot([LOCAL_DEFAULT, LOCAL_WORK, SSH_PARTITION])

    await runWslMoveDesktopRewritePass({ userDataPath })

    const defaultHost = hostPartitionOf('default')
    const workHost = hostPartitionOf('work')
    expect(desktop.copies).toEqual([
      { source: LOCAL_DEFAULT, destination: defaultHost },
      { source: LOCAL_WORK, destination: workHost }
    ])
    expect(jarOf(defaultHost).get('sid')).toBe('desktop-login')
    expect(jarOf(workHost).get('work-sid')).toBe('work-login')
    expect(desktop.flushed.sort()).toEqual([defaultHost, workHost].sort())
    // Sources and every other host's jar are only ever read.
    expect(snapshot([LOCAL_DEFAULT, LOCAL_WORK, SSH_PARTITION])).toEqual(untouched)
    expect(record()?.rewrittenStores).toEqual([WSL_MOVE_BROWSER_COOKIES_STORE_ID])
    expect(record()?.phase).toBe('client-rewritten')
    expect(record()?.browserCookieCopy).toMatchObject({
      outcome: 'copied',
      profiles: [
        { browserProfileId: 'default', destinationPartition: defaultHost, alreadyCopied: false },
        { browserProfileId: 'work', destinationPartition: workHost, alreadyCopied: false }
      ]
    })
  })

  it.each([
    {
      name: 'a WSL environment without its deployment link',
      environments: () => [wslHost('unlinked')],
      reason: 'no-stable-partition'
    },
    {
      name: 'a destination that is not a WSL host',
      environments: () => [hostEnvironment('managed-ssh', 'wsl:Ubuntu')],
      reason: 'destination-not-wsl-host'
    },
    {
      name: 'a removed destination environment',
      environments: () => [],
      reason: 'destination-environment-missing'
    }
  ])('leaves $name on a fresh partition and says why', async ({ environments, reason }) => {
    desktop.environments = environments()
    registerWslMoveBrowserCookieStore(dependencies())
    seedWslMoveCutover(userDataPath, cutover('move-1', 'destination-committed'))
    const before = snapshot([...desktop.jars.keys()])

    await runWslMoveDesktopRewritePass({ userDataPath })

    expect(desktop.copies).toEqual([])
    expect(snapshot([...desktop.jars.keys()])).toEqual(before)
    expect(record()?.browserCookieCopy).toEqual({ outcome: 'fresh-partition', reason })
    expect(record()?.rewrittenStores).toEqual([WSL_MOVE_BROWSER_COOKIES_STORE_ID])
  })

  it('leaves the host fresh when another identity owns its partition name', async () => {
    registerWslMoveBrowserCookieStore(
      dependencies({
        bindHostPartition: (_storage, browserProfileId) => {
          if (browserProfileId === 'work') {
            throw new Error('browser_route_partition_binding_conflict')
          }
          return hostPartitionOf(browserProfileId)
        }
      })
    )
    seedWslMoveCutover(userDataPath, cutover('move-1', 'destination-committed'))

    await runWslMoveDesktopRewritePass({ userDataPath })

    expect(desktop.copies).toEqual([])
    expect(record()?.browserCookieCopy).toEqual({
      outcome: 'fresh-partition',
      reason: 'destination-partition-conflict'
    })
  })

  it('re-runs idempotently after a crash between the copy and its ledger entry', async () => {
    registerWslMoveBrowserCookieStore(dependencies())
    seedWslMoveCutover(userDataPath, cutover('move-1', 'destination-committed'))
    desktop.failFlush = true
    const warn = vi.fn()

    await runWslMoveDesktopRewritePass({ userDataPath, warn })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(record()?.rewrittenStores).toEqual([])
    const defaultHost = hostPartitionOf('default')
    const afterCrash = snapshot([defaultHost])

    desktop.failFlush = false
    await runWslMoveDesktopRewritePass({ userDataPath, warn })

    expect(snapshot([defaultHost])).toEqual(afterCrash)
    expect(record()?.rewrittenStores).toEqual([WSL_MOVE_BROWSER_COOKIES_STORE_ID])
    const outcome = record()?.browserCookieCopy
    expect(outcome?.outcome === 'copied' && outcome.profiles[0]?.counts).toMatchObject({
      copied: 0,
      skippedPresent: 1
    })
  })

  it('waits for browser sessions instead of opening a partition early', async () => {
    registerWslMoveBrowserCookieStore(dependencies())
    seedWslMoveCutover(userDataPath, cutover('move-1', 'destination-committed'))
    desktop.sessionsReady = false
    const warn = vi.fn()

    await runWslMoveDesktopRewritePass({ userDataPath, warn })
    expect(desktop.copies).toEqual([])
    expect(record()?.rewrittenStores).toEqual([])
    expect(warn.mock.calls[0]?.[0]).toContain('wsl_move_browser_sessions_not_ready')

    desktop.sessionsReady = true
    await runWslMoveDesktopRewritePass({ userDataPath, warn })
    expect(record()?.rewrittenStores).toEqual([WSL_MOVE_BROWSER_COOKIES_STORE_ID])
  })

  it('copies once per host: a later move into the same host leaves its jar alone', async () => {
    registerWslMoveBrowserCookieStore(dependencies())
    seedWslMoveCutover(userDataPath, cutover('move-1', 'destination-committed'))
    await runWslMoveDesktopRewritePass({ userDataPath })
    const first = record()
    if (!first) {
      throw new Error('the first move has no journal record')
    }
    // Advancing keeps the record's outcome, as the journal itself does.
    seedWslMoveCutover(userDataPath, { ...first, phase: 'retained' })
    const defaultHost = hostPartitionOf('default')
    // The user signed out on the host; a second copy must not sign them back in.
    jarOf(defaultHost).delete('sid')
    desktop.copies.length = 0

    seedWslMoveCutover(
      userDataPath,
      cutover('move-2', 'destination-committed', { supersedesMigrationId: 'move-1' })
    )
    await runWslMoveDesktopRewritePass({ userDataPath })

    expect(desktop.copies).toEqual([])
    expect(jarOf(defaultHost).has('sid')).toBe(false)
    expect(record('move-2')?.browserCookieCopy).toMatchObject({
      outcome: 'copied',
      profiles: [{ alreadyCopied: true }, { alreadyCopied: true }]
    })
  })

  it('does nothing without a move journal', async () => {
    const sessionsReady = vi.fn(() => true)
    const copyCookies = vi.fn()
    registerWslMoveBrowserCookieStore(dependencies({ sessionsReady, copyCookies }))

    await runWslMoveDesktopRewritePass({ userDataPath })

    expect(sessionsReady).not.toHaveBeenCalled()
    expect(copyCookies).not.toHaveBeenCalled()
    expect(listWslMoveCutovers(userDataPath)).toEqual([])
  })

  it('does nothing while the internal WSL hosts gate is closed', async () => {
    vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '')
    const copyCookies = vi.fn()
    registerWslMoveBrowserCookieStore(dependencies({ copyCookies }))
    seedWslMoveCutover(userDataPath, cutover('move-1', 'destination-committed'))

    await runGatedWslMoveDesktopRewritePass({ userDataPath })

    expect(copyCookies).not.toHaveBeenCalled()
    expect(record()?.rewrittenStores).toEqual([])
  })

  it('still reads a journal whose outcome a newer build wrote', () => {
    const parsed = parseWslMoveCutover({
      ...cutover('move-1', 'destination-committed'),
      browserCookieCopy: { outcome: 'fresh-partition', reason: 'a-reason-from-the-future' }
    })
    expect(parsed.migrationId).toBe('move-1')
    expect(parsed.browserCookieCopy).toBeUndefined()
  })

  it('previews the reason a move would start the host fresh', () => {
    const resolve = dependencies()
    expect(previewWslMoveBrowserCookieCopy(resolve, 'orca-profile-a', wslHost())).toEqual({
      kind: 'copy'
    })
    expect(previewWslMoveBrowserCookieCopy(resolve, 'orca-profile-a', wslHost('unlinked'))).toEqual(
      {
        kind: 'fresh-partition',
        reason: 'no-stable-partition'
      }
    )
    expect(previewWslMoveBrowserCookieCopy(resolve, 'orca-profile-a', undefined)).toEqual({
      kind: 'fresh-partition',
      reason: 'destination-environment-missing'
    })
  })
})
