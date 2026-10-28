import { fetchMobileWebBundle } from '../transport/mobile-web-bundle-fetch'
import { mobileWebBundleManifestRead } from '../transport/mobile-web-bundle-operations'
import { runRpcOperation } from '../transport/rpc-operation'
import type { RpcClient } from '../transport/rpc-client'
import type { GenerationStore } from './generation-store'
import type { MobileWebShellRuntime } from './mobile-web-shell-runtime'
import { generationDirectoryPath } from './generation-store-file-system'
import type {
  CachedGeneration,
  MobileWebShellSessionEvent
} from './mobile-web-shell-session-contract'
import {
  updateFailureCauseOf,
  type MobileWebShellUpdateFailureCause
} from './mobile-web-shell-update-failure'

export async function openCache(
  store: GenerationStore,
  hostKey: string
): Promise<CachedGeneration | null> {
  try {
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
    // Unreadable is not corrupt: leave cache intact and let connectivity decide download versus offline failure.
    return null
  }
}

const NO_CONNECTION: MobileWebShellUpdateFailureCause = { reason: 'no-connection', hostCode: null }
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
  // After verified fetch, failures belong to local staging/commit.
  let fetchedWhole = false
  try {
    const fetched = await fetchMobileWebBundle({
      client,
      signal: controller.signal,
      onProgress: (progress) => send({ type: 'fetch-progress', flow, ...progress }),
      openReusable: (manifest) => store.openReusableAssets(hostKey, manifest)
    })
    // Recheck abort after fetch’s last read so an abandoned screen cannot stage a generation.
    if (controller.signal.aborted) {
      return
    }
    fetchedWhole = true
    send({ type: 'download-staged', flow })
    const staged = await store.stageGeneration(hostKey, fetched)
    // Recheck after staging: abort may remove tmp, but cannot undo a commit’s activation/index changes.
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
