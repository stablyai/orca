import { dirname, join } from 'node:path'
import { resolveAppImageGenerationOfExecutable } from './appimage-generation-lease'
import {
  isAppImageStableLauncherReady,
  resolveAppImageStableLauncherPath
} from './appimage-stable-launcher'

/**
 * The stable launcher when this process runs from an extracted AppImage generation (a service
 * started through that launcher has no $APPIMAGE). Registering the generation's own launcher
 * instead would break once a later update prunes that generation.
 */
export function resolveGenerationStableLauncherPath(resourcesPath: string): string | null {
  const generation = resolveAppImageGenerationOfExecutable(join(dirname(resourcesPath), 'orca-ide'))
  if (!generation || !isAppImageStableLauncherReady(generation.cacheRootPath)) {
    return null
  }
  return resolveAppImageStableLauncherPath(generation.cacheRootPath)
}
