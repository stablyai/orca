import { posix } from 'node:path'
import {
  PLUGIN_MODULE_RESOLVE_EXTENSIONS,
  pluginModuleCandidatePaths
} from '../plugin-module-candidate-paths'

export type PluginModuleSpecifierResolution =
  | { kind: 'keep' }
  | { kind: 'rewrite'; specifier: string }
  | { kind: 'refuse'; reason: string }

/** Whether a plugin-relative `/`-separated path names a file of the plugin. */
export type PluginFileExists = (relativePath: string) => Promise<boolean>

const isOrcaSpecifier = (specifier: string): boolean =>
  specifier === 'orca' || specifier.startsWith('orca/')

// Why kept: URLs are not bare names; the guest CSP decides whether they load.
const isUrlSpecifier = (specifier: string): boolean => /^[a-z][a-z0-9+.-]*:/i.test(specifier)

function relativeSpecifier(fromPath: string, toPath: string): string {
  const relative = posix.relative(posix.dirname(fromPath), toPath)
  const specifier = relative.startsWith('../') ? relative : `./${relative}`
  return specifier.split('/').map(encodeURIComponent).join('/')
}

/**
 * Maps one import of `fromPath` to an exact plugin file. `orca` and URLs are left for the import
 * map and CSP; any other bare name is refused, because there is no bundler to provide it.
 */
export async function resolvePluginModuleSpecifier(
  fromPath: string,
  specifier: string,
  exists: PluginFileExists
): Promise<PluginModuleSpecifierResolution> {
  if (isOrcaSpecifier(specifier) || isUrlSpecifier(specifier)) {
    return { kind: 'keep' }
  }
  if (!specifier.startsWith('./') && !specifier.startsWith('../') && !specifier.startsWith('/')) {
    return {
      kind: 'refuse',
      reason: `cannot import "${specifier}": plugins load without a bundler, so only "orca" and relative files can be imported. Copy the package's ESM files into the plugin and import them by a relative path.`
    }
  }
  const [pathPart] = specifier.split(/[?#]/, 1)
  const suffix = specifier.slice(pathPart.length)
  let decoded: string
  try {
    decoded = decodeURIComponent(pathPart)
  } catch {
    return { kind: 'refuse', reason: `cannot import "${specifier}": malformed escape` }
  }
  const target = decoded.startsWith('/')
    ? posix.normalize(decoded.slice(1))
    : posix.join(posix.dirname(fromPath), decoded)
  if (target === '..' || target.startsWith('../')) {
    return { kind: 'refuse', reason: `cannot import "${specifier}": it is outside the plugin` }
  }
  for (const candidate of pluginModuleCandidatePaths(target.replace(/\/$/, ''))) {
    if (await exists(candidate)) {
      return { kind: 'rewrite', specifier: relativeSpecifier(fromPath, candidate) + suffix }
    }
  }
  return {
    kind: 'refuse',
    reason: `cannot import "${specifier}": no such file in the plugin (tried ${PLUGIN_MODULE_RESOLVE_EXTENSIONS.join(', ')} and index files)`
  }
}
