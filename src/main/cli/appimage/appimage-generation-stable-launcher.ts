import { dirname, join } from 'node:path'
import { resolveAppImageGenerationOfExecutable } from '../../../shared/appimage-cache-identity'
import {
  isAppImageStableLauncherReady,
  resolveAppImageStableLauncherPath
} from './appimage-stable-launcher'

// Generation services lack $APPIMAGE; register the stable launcher so later pruning cannot break it.
export function resolveGenerationStableLauncherPath(resourcesPath: string): string | null {
  const generation = resolveAppImageGenerationOfExecutable(join(dirname(resourcesPath), 'orca-ide'))
  if (!generation || !isAppImageStableLauncherReady(generation.cacheRootPath)) {
    return null
  }
  return resolveAppImageStableLauncherPath(generation.cacheRootPath)
}
