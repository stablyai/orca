import { OrcaMobileWebShellSpares } from '../../modules/orca-mobile-web-shell/src/spares'
import { deriveHostCacheKey } from './host-cache-key'

/** A page booted ahead from a removed host's generation is shown to no one. */
export function discardHostSparePages(hostId: string): void {
  void OrcaMobileWebShellSpares?.discardSpares(deriveHostCacheKey(hostId)).catch(() => undefined)
}
