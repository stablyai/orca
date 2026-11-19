import { describe, expect, it, vi } from 'vitest'
import { createDeferredCommits } from './generation-deferred-commits'
import { createGenerationStore } from './generation-store'
import { createFakeGenerationFileSystem } from './generation-file-system-fake'
import { computeMobileWebBundleId } from '../../../../src/shared/mobile-web-bundle/manifest-contract'
import type { MobileWebBundleFetchResult } from '../../transport/web-bundle/mobile-web-bundle-fetch'
import { MANIFEST_WIRE } from '../test-support/mobile-web-shell-session-test-fixtures'
import { deriveHostCacheKey } from './host-cache-key'

const STAGED = {
  hostKey: 'host',
  buildId: 'build-two',
  directory: '/cache/mobile-web/host/tmp/build-two',
  manifest: MANIFEST_WIRE
}

function page(firstAgain = 2, latestRound = 0) {
  return { swap: vi.fn(), askAgain: vi.fn(() => firstAgain), latestRound: () => latestRound }
}

describe('a resume reloads pages onto a waiting build only when all of them are safe', () => {
  it('asks every page again once all said safe, and reloads them all on the second yes', () => {
    const deferred = createDeferredCommits()
    const visible = page()
    const covered = page()
    const visibleHold = deferred.hold('host', visible)
    const coveredHold = deferred.hold('host', covered)
    deferred.defer(STAGED)
    visibleHold.answer(1, true)
    coveredHold.answer(1, true)
    expect(covered.askAgain).toHaveBeenCalledOnce()
    expect(visible.swap).not.toHaveBeenCalled()
    visibleHold.answer(2, true)
    coveredHold.answer(2, true)
    expect(visible.swap).toHaveBeenCalledOnce()
    expect(covered.swap).toHaveBeenCalledOnce()
  })

  it('keeps every page when the visible page has a draft by the time a covered page answers', () => {
    const deferred = createDeferredCommits()
    const visible = page()
    const covered = page()
    const visibleHold = deferred.hold('host', visible)
    const coveredHold = deferred.hold('host', covered)
    deferred.defer(STAGED)
    visibleHold.answer(1, true)
    coveredHold.answer(1, true)
    visibleHold.answer(2, false)
    coveredHold.answer(2, true)
    expect(visible.swap).not.toHaveBeenCalled()
    expect(covered.swap).not.toHaveBeenCalled()
  })

  it('counts no answer from an earlier resume or from before the app left', () => {
    const deferred = createDeferredCommits()
    const first = page()
    const second = page()
    const firstHold = deferred.hold('host', first)
    const secondHold = deferred.hold('host', second)
    deferred.defer(STAGED)
    firstHold.answer(1, true)
    secondHold.answer(3, true)
    firstHold.answer(1, true)
    firstHold.withdraw()
    firstHold.answer(3, true)
    secondHold.answer(3, true)
    expect(first.askAgain).not.toHaveBeenCalled()
    expect(second.askAgain).not.toHaveBeenCalled()
  })

  it('counts no answer to a round asked before the app left, even one that arrives later', () => {
    const deferred = createDeferredCommits()
    const only = page(9, 5)
    const hold = deferred.hold('host', only)
    deferred.defer(STAGED)
    hold.withdraw()
    hold.answer(4, true)
    hold.answer(5, true)
    expect(only.askAgain).not.toHaveBeenCalled()
    hold.answer(6, true)
    expect(only.askAgain).toHaveBeenCalledOnce()
  })

  it('reloads nothing when no newer build waits', () => {
    const deferred = createDeferredCommits()
    const only = page()
    deferred.hold('host', only).answer(1, true)
    expect(only.askAgain).not.toHaveBeenCalled()
  })
})

describe('a staged build that failed to commit', () => {
  function bundle(pageBytes: number): MobileWebBundleFetchResult {
    const assets = [
      {
        path: 'index.html',
        sha256: 'a'.repeat(64),
        byteLength: pageBytes,
        contentType: 'text/html'
      }
    ]
    return {
      manifest: {
        ...MANIFEST_WIRE,
        buildId: computeMobileWebBundleId(assets),
        totalBytes: 0,
        assets
      },
      assets: new Map(assets.map((asset) => [asset.path, new Uint8Array(asset.byteLength)])),
      reused: [],
      totalBytes: 0,
      elapsedMs: 1
    }
  }

  it('is not fetched again until the host offers a different build', async () => {
    const host = deriveHostCacheKey('host-a')
    const fileSystem = createFakeGenerationFileSystem()
    const store = createGenerationStore({ fileSystem })
    await store.commitGeneration(await store.stageGeneration(host, bundle(4)))
    const update = bundle(8)
    store.deferCommit(await store.stageGeneration(host, update))
    fileSystem.loseContentsOnMove()
    await store.readActiveGeneration(host)
    expect(await store.claimUpdate(host, update.manifest.buildId)).toBeNull()
    expect(await store.claimUpdate(host, bundle(16).manifest.buildId)).toBeTypeOf('function')
  })
})
