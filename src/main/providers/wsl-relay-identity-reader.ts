// Host adapter for the WSL relay's process capability. Keeping this boundary
// here makes it impossible for callers to fall back to a per-event wsl.exe ps.
import {
  wslHookRelayManager,
  type WslHookRelayManager
} from '../agent-hooks/wsl-hook-relay-manager'
import type { WslRelayIdentityResult } from '../../shared/wsl-hook-relay-contract'
import type { WslShellProcessAnchor } from '../../shared/wsl-shell-process-anchor'

export type WslRelayIdentityReader = {
  read: (
    distro: string,
    anchor: WslShellProcessAnchor,
    options?: { signal?: AbortSignal; timeoutMs?: number }
  ) => Promise<WslRelayIdentityResult>
  readBatch: (
    distro: string,
    anchors: readonly WslShellProcessAnchor[],
    options?: { signal?: AbortSignal; timeoutMs?: number; stableUntilReset?: boolean }
  ) => Promise<WslRelayIdentityResult[]>
  reset: () => void
}

export function createWslRelayIdentityReader(
  manager: Pick<WslHookRelayManager, 'readProcessIdentity'> = wslHookRelayManager
): WslRelayIdentityReader {
  const cache = new Map<
    string,
    {
      at: number
      anchors: readonly WslShellProcessAnchor[]
      results: WslRelayIdentityResult[]
      stableUntilReset: boolean
    }
  >()
  const pending = new Map<
    string,
    {
      promise: Promise<{
        anchors: readonly WslShellProcessAnchor[]
        results: WslRelayIdentityResult[]
      }>
      stableUntilReset: boolean
      resetGeneration: number
    }
  >()
  let resetGeneration = 0
  const readBatch = async (
    distro: string,
    anchors: readonly WslShellProcessAnchor[],
    options?: { signal?: AbortSignal; timeoutMs?: number; stableUntilReset?: boolean }
  ): Promise<WslRelayIdentityResult[]> => {
    const key = distro.trim().toLowerCase()
    const now = Date.now()
    const prior = cache.get(key)
    if (
      prior &&
      ((options?.stableUntilReset === true && prior.stableUntilReset) || now - prior.at < 500)
    ) {
      if (options?.stableUntilReset === true) {
        prior.stableUntilReset = true
      }
      const byAnchor = new Map(
        prior.anchors.map((anchor, index) => [JSON.stringify(anchor), prior.results[index]!])
      )
      if (anchors.every((anchor) => byAnchor.has(JSON.stringify(anchor)))) {
        return anchors.map((anchor) => {
          const result = byAnchor.get(JSON.stringify(anchor))!
          return {
            ...result,
            capturedAgeMs: result.capturedAgeMs + Math.max(0, now - prior.at)
          }
        })
      }
    }
    const active = pending.get(key)
    if (active) {
      if (options?.stableUntilReset === true) {
        active.stableUntilReset = true
      }
      const result = await active.promise
      const byAnchor = new Map(
        result.anchors.map((anchor, index) => [JSON.stringify(anchor), result.results[index]!])
      )
      if (anchors.every((anchor) => byAnchor.has(JSON.stringify(anchor)))) {
        return anchors.map((anchor) => byAnchor.get(JSON.stringify(anchor))!)
      }
    }
    const requestGeneration = resetGeneration
    const activeRequest = {
      stableUntilReset: options?.stableUntilReset === true,
      resetGeneration: requestGeneration,
      promise: manager
        .readProcessIdentity(distro, anchors, options)
        .then((results) => ({ anchors, results }))
    }
    pending.set(key, activeRequest)
    try {
      const result = await activeRequest.promise
      if (activeRequest.resetGeneration === resetGeneration) {
        cache.set(key, {
          at: Date.now(),
          stableUntilReset: activeRequest.stableUntilReset || prior?.stableUntilReset === true,
          ...result
        })
      }
      return result.results
    } finally {
      if (pending.get(key) === activeRequest) {
        pending.delete(key)
      }
    }
  }
  return {
    read: async (distro, anchor, options) => (await readBatch(distro, [anchor], options))[0]!,
    readBatch,
    reset: () => {
      resetGeneration += 1
      cache.clear()
      pending.clear()
    }
  }
}

export const wslRelayIdentityReader = createWslRelayIdentityReader()
