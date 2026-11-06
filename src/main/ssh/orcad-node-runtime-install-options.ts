import type { NodeRuntimeTarget } from '../../shared/node-runtime-pin'
import {
  materializeNodeRuntimeArchive,
  nodeRuntimeArchiveCachePath
} from '../node-runtime/pinned-runtime-materializer'

/** WSL only: bounded Node runtime downloads. SSH passes none and keeps the default timing. */
export type NodeRuntimeDownloadBudget = {
  desktopConnectTimeoutMs: number
  hostConnectTimeoutSeconds: number
}

/** How a deploy acquires the pinned Node archive, and what it names when every download fails. */
export function orcadNodeRuntimeInstallOptions(
  target: NodeRuntimeTarget,
  runtimeCacheRoot: string,
  input: { signal?: AbortSignal; nodeRuntimeDownload?: NodeRuntimeDownloadBudget }
) {
  return {
    nodeRuntimeArchive: () =>
      materializeNodeRuntimeArchive(target, runtimeCacheRoot, {
        signal: input.signal,
        connectTimeoutMs: input.nodeRuntimeDownload?.desktopConnectTimeoutMs
      }),
    nodeRuntimeOfflineArchivePath: nodeRuntimeArchiveCachePath(target, runtimeCacheRoot),
    nodeRuntimeHostConnectTimeoutSeconds: input.nodeRuntimeDownload?.hostConnectTimeoutSeconds
  }
}
