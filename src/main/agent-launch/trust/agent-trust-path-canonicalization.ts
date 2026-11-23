import { existsSync, realpathSync } from 'node:fs'

/** Match agent trust lookups that compare realpaths, including macOS /tmp symlinks. */
export function canonicalizeAgentTrustPath(p: string): string {
  try {
    if (existsSync(p)) {
      return realpathSync.native(p)
    }
  } catch {}
  return p
}
