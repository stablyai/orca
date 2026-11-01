import { posix } from 'node:path'
import { resolveContainedPluginArtifact } from '../plugin-artifact-validation'
import type { PluginFrameFileDigests } from './plugin-frame-integrity'
import type { PluginFileExists } from './plugin-frame-module-resolution'

/** Imports resolve against the verified file list; a mutable dev tree has none, so ask the disk. */
export function pluginFileExistsIn(
  rootDir: string,
  digests: PluginFrameFileDigests
): PluginFileExists {
  if (digests !== null) {
    return async (relativePath) => digests.has(relativePath)
  }
  return async (relativePath) =>
    resolveContainedPluginArtifact(rootDir, relativePath).then(
      () => true,
      () => false
    )
}

/** Marks the request for a `.ts` frame entry's module; the same path without it is its page. */
export const PLUGIN_SOURCE_MODULE_QUERY = 'orca-module'

/** The page Orca serves for a `.tsx`/`.ts` frame entry: it only loads that entry as a module. */
export function pluginSourceModuleDocumentBody(relativePath: string): string {
  const src = `./${encodeURIComponent(posix.basename(relativePath))}?${PLUGIN_SOURCE_MODULE_QUERY}`
  return `<div id="root"></div>\n<script type="module" src="${src}"></script>\n`
}
