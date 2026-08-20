import { parseWslUncPath } from '../../shared/wsl-paths'
import { listRunningWslDistrosAsync } from '../wsl'
import { abandonRemoteSessionScanOnCancel } from './ai-vault-scan-cancellation'

/**
 * The name of the stopped distro a UNC root belongs to, or null when the
 * root should be scanned normally (not a WSL UNC path, the distro is
 * running, or the probe itself failed — fail open, never boots anything).
 */
export async function stoppedWslDistroForRoot(
  rootDir: string,
  signal?: AbortSignal
): Promise<string | null> {
  const info = parseWslUncPath(rootDir)
  if (!info) {
    return null
  }
  // Why: the running-distros probe is deduped across concurrent callers, so
  // this must not abort the shared subprocess — only stop this caller from
  // waiting on it.
  const running = await abandonRemoteSessionScanOnCancel(listRunningWslDistrosAsync(), signal)
  if (running === null) {
    return null
  }
  const wanted = info.distro.toLowerCase()
  return [...running].some((distro) => distro.toLowerCase() === wanted) ? null : info.distro
}
