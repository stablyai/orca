import { fetchMobileWebBundle } from '../transport/mobile-web-bundle-fetch'
import {
  isMobileWebBundleTransportFailure,
  mobileWebBundleManifestRead
} from '../transport/mobile-web-bundle-operations'
import { runRpcOperation } from '../transport/rpc-operation'
import type { RpcClient } from '../transport/rpc-client'
import type { GenerationStore } from './generation-store'
import type { MobileWebShellRuntime } from './mobile-web-shell-runtime'
import { generationDirectoryPath } from './generation-store-file-system'
import type {
  CachedGeneration,
  MobileWebShellReadFailure,
  MobileWebShellSessionEvent
} from './mobile-web-shell-session-contract'

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
    // Here and nowhere earlier: with the flag off no code path reaches this hook, so a store build
    // never sweeps a cache it never wrote.
    await store.sweepStagedGenerations()
    const active = await store.readActiveGeneration(hostKey)
    return active === null
      ? null
      : {
          buildId: active.buildId,
          directory: generationDirectoryPath(active.directory),
          totalBytes: active.manifest.totalBytes,
          routes: active.manifest.routes
        }
  } catch {
    // A cache that cannot be read is not a cache that is wrong: nothing is deleted, and the flow
    // treats it as absent, which downloads when connected and says so when not.
    return null
  }
}

/** A rejection the link caused says nothing about the bundle, and the reducer opens the cache on it
 *  rather than telling a phone that already holds a workspace it could not be downloaded. */
function readFailure(error: unknown): MobileWebShellReadFailure {
  return isMobileWebBundleTransportFailure(error) ? 'transport' : 'bundle'
}

export async function readManifest(
  client: RpcClient | null,
  flow: number,
  send: (event: MobileWebShellSessionEvent) => void
): Promise<void> {
  if (client === null) {
    // No client is no link, and the gates are about to say so.
    send({ type: 'download-failed', flow, failure: 'transport' })
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
        totalBytes: manifest.totalBytes,
        totalAssets: manifest.assets.length,
        routes: manifest.routes,
        wire: manifest
      }
    })
  } catch (error) {
    send({ type: 'download-failed', flow, failure: readFailure(error) })
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
    send({ type: 'download-failed', flow, failure: 'transport' })
    return
  }
  const controller = new AbortController()
  args.downloads.add(controller)
  try {
    const fetched = await fetchMobileWebBundle({
      client,
      signal: controller.signal,
      onProgress: (progress) => send({ type: 'fetch-progress', flow, ...progress })
    })
    // The bytes are in; the session they were for may not be. The fetch throws on an abort it sees,
    // but an abort landing between its last read and this line would otherwise still write a
    // generation for a host screen nobody is on any more.
    if (controller.signal.aborted) {
      return
    }
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
    send({ type: 'download-failed', flow, failure: readFailure(error) })
  } finally {
    args.downloads.delete(controller)
  }
}
