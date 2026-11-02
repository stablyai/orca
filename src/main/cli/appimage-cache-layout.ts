import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isAppImageCacheKey } from '../../shared/appimage-cache-identity'
import { LINUX_CLI_COMMAND_NAME } from './bundled-cli-launcher-path'

export { isAppImageCacheKey }

export function resolveCachedAppImagePayloadRoot(
  cacheRootPath: string,
  candidatePath: string,
  launcherName = LINUX_CLI_COMMAND_NAME
): string | null {
  if (!isAbsolute(candidatePath)) {
    return null
  }
  const resolvedCacheRoot = resolve(cacheRootPath)
  const segments = relative(resolvedCacheRoot, resolve(candidatePath)).split(sep)
  const [namespaceKey, generationKey, resources, bin, candidateLauncherName] = segments
  if (
    segments.length !== 5 ||
    !namespaceKey ||
    !generationKey ||
    !isAppImageCacheKey(namespaceKey) ||
    !isAppImageCacheKey(generationKey) ||
    resources !== 'resources' ||
    bin !== 'bin' ||
    candidateLauncherName !== launcherName
  ) {
    return null
  }
  return join(resolvedCacheRoot, namespaceKey, generationKey)
}
