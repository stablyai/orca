import { useEffect } from 'react'
import { useIsFocused } from 'expo-router'
import type { OrcaMobileWebShellSparesModule } from '../../modules/orca-mobile-web-shell/src/spares'
import { useAppActive } from '../hooks/use-app-active'
import { generationDirectoryPath } from './generation-store-file-system'
import { deriveHostCacheKey } from './host-cache-key'
import type { MobileWebShellRuntime } from './mobile-web-shell-runtime'

/** After the page on screen painted: its route chunks share the renderer the spare boots in. */
export const SPARE_REFILL_DELAY_MS = 1000

/**
 * Boots one page for the next screen this host opens, once this one has painted and while it is the
 * screen in front of a foreground app. Skipped when the page owns the host area: its screens open
 * inside it, so a spare would rarely be shown. The native pool keeps one spare and ignores a repeat.
 */
export function useSparePageRefill(args: {
  hostId: string
  generationDirectory: string | null
  painted: boolean
  ownsHostArea: boolean
  runtime: MobileWebShellRuntime
}): void {
  const { hostId, generationDirectory, painted, ownsHostArea, runtime } = args
  const focused = useIsFocused()
  const active = useAppActive()
  const { spares } = runtime
  const directory = painted && !ownsHostArea && focused && active ? generationDirectory : null
  useEffect(() => {
    if (directory === null || spares === undefined) {
      return
    }
    let live = true
    const cancel = runtime.setTimer(() => {
      void refill(runtime, spares, deriveHostCacheKey(hostId), directory, () => live)
    }, SPARE_REFILL_DELAY_MS)
    return () => {
      live = false
      cancel()
    }
  }, [directory, hostId, runtime, spares])
}

async function refill(
  runtime: MobileWebShellRuntime,
  spares: OrcaMobileWebShellSparesModule,
  hostKey: string,
  directory: string,
  isLive: () => boolean
): Promise<void> {
  // A screen left behind by an update shows a generation the store has deleted; a spare booted from
  // it would fail and evict the one booted from the current tree.
  const current = await runtime
    .createStore()
    .readActiveGeneration(hostKey)
    .catch(() => null)
  if (!isLive() || current === null || generationDirectoryPath(current.directory) !== directory) {
    return
  }
  await spares.prepareSpare(hostKey, directory, runtime.mintSessionId()).catch(() => undefined)
}
