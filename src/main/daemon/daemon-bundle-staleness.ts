import { readFileSync } from 'node:fs'
import { getDaemonPidPath } from './daemon-spawner'
import { readVerifiedDaemonPid } from './daemon-pid-identity'
import { PROTOCOL_VERSION } from './types'

let cachedDaemonBundleStaleness: {
  key: string
  pending: Promise<boolean | null>
} | null = null

export async function isDaemonStaleForCurrentBundle(
  runtimeDir: string,
  socketPath: string,
  tokenPath: string,
  currentAppVersion: string,
  protocolVersion = PROTOCOL_VERSION
): Promise<boolean> {
  let cacheKey: string | null = null
  try {
    cacheKey = JSON.stringify([
      runtimeDir,
      socketPath,
      tokenPath,
      currentAppVersion,
      protocolVersion,
      readFileSync(getDaemonPidPath(runtimeDir, protocolVersion), 'utf8')
    ])
  } catch {
    // Retry the verified read below so a transient PID-file race does not become sticky.
  }

  if (cacheKey && cachedDaemonBundleStaleness?.key === cacheKey) {
    return (await cachedDaemonBundleStaleness.pending) ?? false
  }

  const pending = (async (): Promise<boolean | null> => {
    const parsedPid = await readVerifiedDaemonPid(
      runtimeDir,
      socketPath,
      tokenPath,
      protocolVersion
    )
    if (!parsedPid) {
      return null
    }

    if (parsedPid.appVersion !== null) {
      return parsedPid.appVersion !== currentAppVersion
    }

    // Why: older packaged daemons do not carry a reliable build-generation
    // marker. Replacing them once prevents archive-preserved mtimes from
    // reusing stale native modules across the first metadata-aware upgrade.
    return true
  })()
  if (cacheKey) {
    cachedDaemonBundleStaleness = { key: cacheKey, pending }
  }
  const stale = await pending
  if (
    stale === null &&
    cachedDaemonBundleStaleness?.key === cacheKey &&
    cachedDaemonBundleStaleness.pending === pending
  ) {
    cachedDaemonBundleStaleness = null
  }
  return stale ?? false
}
