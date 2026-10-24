import { fetchMobileWebBundle } from '../transport/mobile-web-bundle-fetch'
import { mobileWebBundleManifestRead } from '../transport/mobile-web-bundle-operations'
import { runRpcOperation } from '../transport/rpc-operation'
import type { RpcClient } from '../transport/rpc-client'
import type { GenerationStore } from './generation-store'
import {
  DOCUMENT_LOAD_DEADLINE_MS,
  PAGE_READY_DEADLINE_MS,
  type MobileWebShellRuntime
} from './mobile-web-shell-runtime'
import { generationDirectoryPath } from './generation-store-file-system'
import type {
  CachedGeneration,
  MobileWebShellSessionEffect,
  MobileWebShellSessionEvent
} from './mobile-web-shell-session-contract'
import {
  updateFailureCauseOf,
  type MobileWebShellUpdateFailureCause
} from './mobile-web-shell-update-failure'

/**
 * The work the session's effects do: read the cache, read the manifest, download a generation.
 *
 * Split from the hook because these are the only parts that touch the network and the disk, and
 * the hook above them is a reducer and a set of callbacks. Each one answers by sending an event
 * back; none of them decides anything.
 */
export async function openCache(
  store: GenerationStore,
  hostKey: string
): Promise<CachedGeneration | null> {
  try {
    // Here and nowhere earlier: only a mounted shell sweeps, so nothing sweeps a cache it never wrote.
    await store.sweepStagedGenerations()
    const active = await store.readActiveGeneration(hostKey)
    return active === null
      ? null
      : {
          buildId: active.buildId,
          directory: generationDirectoryPath(active.directory),
          totalBytes: active.manifest.totalBytes,
          routes: active.manifest.routes,
          compat: {
            schemaVersion: active.manifest.schemaVersion,
            runtimeProtocolVersion: active.manifest.runtimeProtocolVersion,
            minCompatibleRuntimeProtocolVersion:
              active.manifest.minCompatibleRuntimeProtocolVersion,
            pageVersion: active.manifest.pageVersion
          }
        }
  } catch {
    // A cache that cannot be read is not a cache that is wrong: nothing is deleted, and the flow
    // treats it as absent, which downloads when connected and says so when not.
    return null
  }
}

/** No client is no link, and the gates are about to say so. */
const NO_CONNECTION: MobileWebShellUpdateFailureCause = { reason: 'no-connection', hostCode: null }
/** Bytes that arrived whole and verified, refused by this phone's own disk. */
const CACHE_WRITE_FAILED: MobileWebShellUpdateFailureCause = {
  reason: 'cache-write-failed',
  hostCode: null
}

export async function readManifest(
  client: RpcClient | null,
  flow: number,
  send: (event: MobileWebShellSessionEvent) => void
): Promise<void> {
  if (client === null) {
    send({ type: 'download-failed', flow, cause: NO_CONNECTION })
    return
  }
  try {
    const opened = await runRpcOperation(client, mobileWebBundleManifestRead, null)
    const manifest = opened.manifest
    send({
      type: 'manifest-read',
      flow,
      manifest: {
        buildId: manifest.buildId,
        schemaVersion: manifest.schemaVersion,
        runtimeProtocolVersion: manifest.runtimeProtocolVersion,
        minCompatibleRuntimeProtocolVersion: manifest.minCompatibleRuntimeProtocolVersion,
        pageVersion: manifest.pageVersion,
        totalBytes: manifest.totalBytes,
        totalAssets: manifest.assets.length,
        routes: manifest.routes
      }
    })
  } catch (error) {
    send({ type: 'download-failed', flow, cause: updateFailureCauseOf(error) })
  }
}

export async function download(args: {
  client: RpcClient | null
  store: GenerationStore
  hostKey: string
  flow: number
  runtime: MobileWebShellRuntime
  startedAt: number
  downloads: Set<AbortController>
  send: (event: MobileWebShellSessionEvent) => void
}): Promise<void> {
  const { client, store, hostKey, flow, runtime, send } = args
  if (client === null) {
    send({ type: 'download-failed', flow, cause: NO_CONNECTION })
    return
  }
  const controller = new AbortController()
  args.downloads.add(controller)
  // Past the fetch, a throw is the store's: the bytes had already verified.
  let fetchedWhole = false
  try {
    // A cache that cannot be opened is one with nothing to reuse, not a failed download.
    const reusable = await store.openReusableAssets(hostKey).catch(() => undefined)
    const fetched = await fetchMobileWebBundle({
      client,
      signal: controller.signal,
      onProgress: (progress) => send({ type: 'fetch-progress', flow, ...progress }),
      reusable
    })
    // The bytes are in; the session they were for may not be. The fetch throws on an abort it sees,
    // but an abort landing between its last read and this line would otherwise still write a
    // generation for a host screen nobody is on any more.
    if (controller.signal.aborted) {
      return
    }
    fetchedWhole = true
    send({ type: 'download-staged', flow })
    const staged = await store.stageGeneration(hostKey, fetched)
    // Again before the commit, because the commit is the write that is not the staging tree's to
    // undo: it renames into the active slot and moves the host index. An abort that landed while
    // the bytes were being staged takes the staged tree back out instead.
    if (controller.signal.aborted) {
      await store.abortStagedGeneration(staged).catch(() => undefined)
      return
    }
    const committed = await store.commitGeneration(staged)
    send({
      type: 'activated',
      flow,
      generationDirectory: generationDirectoryPath(committed.directory),
      sessionId: runtime.mintSessionId(),
      buildId: committed.buildId,
      totalBytes: committed.manifest.totalBytes,
      elapsedMs: runtime.now() - args.startedAt
    })
  } catch (error) {
    send({
      type: 'download-failed',
      flow,
      cause: fetchedWhole ? CACHE_WRITE_FAILED : updateFailureCauseOf(error)
    })
  } finally {
    args.downloads.delete(controller)
  }
}

export async function runMobileWebShellSessionEffect(args: {
  effect: MobileWebShellSessionEffect
  flow: number
  client: RpcClient | null
  store: GenerationStore
  hostId: string
  hostKey: string
  runtime: MobileWebShellRuntime
  startedAt: number
  downloads: Set<AbortController>
  timers: Set<() => void>
  send: (event: MobileWebShellSessionEvent) => void
}): Promise<void> {
  const {
    effect,
    flow,
    client,
    store,
    hostId,
    hostKey,
    runtime,
    startedAt,
    downloads,
    timers,
    send
  } = args
  switch (effect.kind) {
    case 'delete-cache':
      await store.deleteHostCache(hostKey).catch(() => undefined)
      return
    case 'record-update-failure':
      await store.recordUpdateFailure({ ...effect.failure, hostId, at: runtime.now() })
      return
    case 'forget-update-failures':
      await store.forgetHostUpdateFailures(hostId)
      return
    case 'open-cache':
      send({ type: 'cache-read', flow, generation: await openCache(store, hostKey) })
      return
    case 'read-manifest':
      await readManifest(client, flow, send)
      return
    case 'download':
      await download({ client, store, hostKey, flow, runtime, startedAt, downloads, send })
      return
    case 'open-generation':
      send({
        type: 'activated',
        flow,
        generationDirectory: effect.directory,
        sessionId: runtime.mintSessionId(),
        buildId: effect.buildId,
        totalBytes: effect.totalBytes,
        elapsedMs: runtime.now() - startedAt
      })
      return
    case 'remount':
      send({ type: 'remounted', flow, sessionId: runtime.mintSessionId() })
      return
    case 'await-page-ready':
    case 'await-document-load': {
      const pageReady = effect.kind === 'await-page-ready'
      const cancel = runtime.setTimer(
        () => {
          timers.delete(cancel)
          send({ type: pageReady ? 'page-ready-deadline' : 'document-load-deadline', flow })
        },
        pageReady ? PAGE_READY_DEADLINE_MS : DOCUMENT_LOAD_DEADLINE_MS
      )
      timers.add(cancel)
    }
  }
}
