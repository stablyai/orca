import { readFile, realpath, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  pluginHostCallFindings,
  type PluginCodeRead,
  type PluginHostCallFindings
} from '../../../shared/plugins/authoring/plugin-host-call-checks'
import type { PluginManifest } from '../../../shared/plugins/manifest/plugin-manifest'
import { isInsidePluginRoot } from './plugin-contained-artifact'

/** Reads a plugin file for the host-call scan: by its real path, and never past `maxBytes`. */
async function readPluginCode(
  root: string,
  rootReal: string,
  manifestPath: string,
  maxBytes: number
): Promise<PluginCodeRead> {
  let real: string
  try {
    real = await realpath(resolve(root, ...manifestPath.split('/')))
  } catch {
    // Why null: the scan probes import suffixes, so most misses are expected.
    return null
  }
  if (!isInsidePluginRoot(rootReal, real)) {
    return { skipped: 'a symlink takes it outside the plugin' }
  }
  const info = await stat(real)
  if (!info.isFile()) {
    return null
  }
  // Why stat first: a huge bundle must be refused before it is read into memory.
  if (info.size > maxBytes) {
    return { skipped: `larger than ${maxBytes} bytes` }
  }
  return { text: await readFile(real, 'utf8') }
}

/** The host-call findings `orca plugin validate` and `pnpm validate:plugin` report for a folder. */
export async function validatePluginHostCalls(
  root: string,
  manifest: PluginManifest
): Promise<PluginHostCallFindings> {
  const rootReal = await realpath(resolve(root))
  return pluginHostCallFindings(manifest, (path, maxBytes) =>
    readPluginCode(root, rootReal, path, maxBytes)
  )
}
