import { doubles } from './mobile-web-shell-protocol-test-fixtures'
import {
  HOST_ID,
  GOOD_BUILD_ID,
  NEWER_BUILD_ID,
  NEWER_MANIFEST,
  STALE_MANIFEST,
  fetchResultFor,
  cacheGeneration,
  refuseTheAssets,
  mountRoute,
  generationTree,
  cachedBuildIds
} from './mobile-web-shell-route-test-fixtures'
import { beforeEach, describe, expect, it } from 'vitest'
import { MOBILE_WEB_BUNDLE_CAPABILITY } from '../../../src/shared/mobile-web-bundle/mobile-web-bundle-capability'
import { createFakeGenerationFileSystem, FAKE_GENERATION_ROOT } from './generation-file-system-fake'
import { createGenerationStore } from './generation-store'
describe('an update the shell refuses while the host is reachable', () => {
  beforeEach(() => {
    doubles.connection = { client: {}, state: 'connected' }
    doubles.gates.hostCapabilities = [MOBILE_WEB_BUNDLE_CAPABILITY]
    doubles.manifest = NEWER_MANIFEST
    doubles.fetch = refuseTheAssets
  })

  it('serves the generation on disk instead of a wall, and says why', async () => {
    const fileSystem = createFakeGenerationFileSystem()
    await cacheGeneration(fileSystem)

    const mounted = await mountRoute(fileSystem)

    expect(mounted.state()).toMatchObject({ kind: 'ready', buildId: GOOD_BUILD_ID })
    expect(mounted.updateNotice()).toBe('update-failed')
  })

  it('leaves the refused generation off the disk and the intact one on it', async () => {
    const fileSystem = createFakeGenerationFileSystem()
    await cacheGeneration(fileSystem)
    const settled = generationTree(fileSystem)

    const mounted = await mountRoute(fileSystem)
    expect(mounted.state()).toMatchObject({ kind: 'ready' })

    expect(cachedBuildIds(fileSystem)).toEqual([GOOD_BUILD_ID])
    expect(generationTree(fileSystem)).toEqual(settled)
    expect(fileSystem.paths().filter((path) => path.includes('/tmp'))).toEqual([])
  })

  it('walls as it always did when there is no generation to fall back to', async () => {
    const fileSystem = createFakeGenerationFileSystem()

    const mounted = await mountRoute(fileSystem)

    expect(mounted.state()).toEqual({
      kind: 'failed',
      reason: 'download-failed',
      retriedOnce: false
    })
    expect(mounted.updateNotice()).toBeNull()
  })

  it('walls a generation whose declared runtime the host has moved past', async () => {
    // Decide compatibility from the persisted manifest beside the cached bytes, not an injected value.
    const fileSystem = createFakeGenerationFileSystem()
    await cacheGeneration(fileSystem, STALE_MANIFEST)

    const mounted = await mountRoute(fileSystem)

    expect(mounted.state()).toEqual({
      kind: 'wall',
      verdict: {
        kind: 'blocked',
        reason: 'bundle-incompatible',
        side: 'mobile',
        bundleRuntimeProtocolVersion: 0,
        requiredBundleRuntimeProtocolVersion: 1
      }
    })
    expect(mounted.updateNotice()).toBeNull()
    expect(cachedBuildIds(fileSystem)).toEqual([GOOD_BUILD_ID])
  })

  it('writes down why on the device, which is all a release build keeps', async () => {
    const fileSystem = createFakeGenerationFileSystem()
    await cacheGeneration(fileSystem)

    const mounted = await mountRoute(fileSystem)
    expect(mounted.state()).toMatchObject({ kind: 'ready', buildId: GOOD_BUILD_ID })

    expect(await createGenerationStore({ fileSystem }).readUpdateFailures()).toEqual([
      {
        hostId: HOST_ID,
        at: 0,
        reason: 'asset-short',
        hostCode: null,
        offeredBuildId: NEWER_BUILD_ID,
        cachedBuildId: GOOD_BUILD_ID,
        outcome: 'opened-cached',
        wall: null
      }
    ])
  })

  it('records a failure whose error named an endpoint and a token without either', async () => {
    doubles.fetch = () =>
      Promise.reject(new Error('dial wss://relay.example/pair?token=SECRET-123 refused'))
    const fileSystem = createFakeGenerationFileSystem()
    await cacheGeneration(fileSystem)

    await mountRoute(fileSystem)

    const log = await fileSystem.readText(`${FAKE_GENERATION_ROOT}/update-failures.json`)
    expect(log).toContain('unrecognised-error')
    expect(log).not.toMatch(/SECRET|token|\?|:\/\/|relay/)
  })

  it("forgets this host's failures once a newer generation commits, and no other host's", async () => {
    const fileSystem = createFakeGenerationFileSystem()
    await cacheGeneration(fileSystem)
    const other = {
      hostId: 'host-2',
      at: 0,
      reason: 'connection-lost',
      hostCode: null,
      offeredBuildId: null,
      cachedBuildId: null,
      outcome: 'opened-cached',
      wall: null
    } as const
    await createGenerationStore({ fileSystem }).recordUpdateFailure(other)

    await (await mountRoute(fileSystem)).unmount()
    const afterRefusal = await createGenerationStore({ fileSystem }).readUpdateFailures()
    expect(afterRefusal.map((entry) => entry.hostId)).toEqual(['host-2', HOST_ID])

    doubles.fetch = () => Promise.resolve(fetchResultFor(NEWER_MANIFEST))
    const updated = await mountRoute(fileSystem)
    expect(updated.state()).toMatchObject({ kind: 'ready', buildId: NEWER_BUILD_ID })

    expect(await createGenerationStore({ fileSystem }).readUpdateFailures()).toEqual([other])
  })

  it('asks the host again on the next launch rather than living under the fallback', async () => {
    const fileSystem = createFakeGenerationFileSystem()
    await cacheGeneration(fileSystem)

    const refused = await mountRoute(fileSystem)
    expect(refused.state()).toMatchObject({ kind: 'ready', buildId: GOOD_BUILD_ID })
    await refused.unmount()

    doubles.fetch = () => Promise.resolve(fetchResultFor(NEWER_MANIFEST))
    const updated = await mountRoute(fileSystem)

    expect(updated.state()).toMatchObject({ kind: 'ready', buildId: NEWER_BUILD_ID })
    expect(updated.updateNotice()).toBeNull()
    expect(cachedBuildIds(fileSystem)).toEqual([NEWER_BUILD_ID])
  })
})

// Native presentation and identity are inert; controls, preference owners, bridge and socket are real.
