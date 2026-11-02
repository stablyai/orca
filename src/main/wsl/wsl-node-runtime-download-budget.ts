import type { NodeRuntimeDownloadBudget } from '../ssh/orcad-node-runtime-install-options'

/**
 * A first WSL deploy fetches the pinned Node archive. Behind a firewall that drops packets the default
 * timing (four desktop attempts, then 20 s per host source) left the connect hanging about two minutes.
 * Bounded here: one 15 s desktop attempt, then 15 s per host source (the official URL, plus a mirror if
 * set), so a dead network fails in about 30-45 s. The host fallback stays: when the desktop's proxy refuses,
 * the distro's own route is often what succeeds.
 */
export const WSL_NODE_RUNTIME_DOWNLOAD_BUDGET: NodeRuntimeDownloadBudget = {
  desktopConnectTimeoutMs: 15_000,
  hostConnectTimeoutSeconds: 15
}
