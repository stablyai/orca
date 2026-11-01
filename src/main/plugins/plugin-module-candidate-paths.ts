import { posix } from 'node:path'

// Shared by frame imports and worker imports so both resolve a relative specifier the same way.

/** Tried in order for an extensionless relative import, then as `<dir>/index.<ext>`. */
export const PLUGIN_MODULE_RESOLVE_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js', '.mts', '.mjs']
// Why: TypeScript ESM style imports `./util.js` for `util.ts`.
const SOURCE_FOR_OUTPUT_EXTENSION: Record<string, readonly string[]> = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts']
}

/** Files a `/`-separated import target may name, most specific first. */
export function pluginModuleCandidatePaths(target: string): string[] {
  const extension = posix.extname(target).toLowerCase()
  const stem = target.slice(0, target.length - extension.length)
  return [
    ...(extension ? [target] : []),
    ...(SOURCE_FOR_OUTPUT_EXTENSION[extension] ?? []).map((source) => stem + source),
    ...(extension ? [] : PLUGIN_MODULE_RESOLVE_EXTENSIONS.map((each) => target + each)),
    ...PLUGIN_MODULE_RESOLVE_EXTENSIONS.map((each) => posix.join(target, `index${each}`))
  ]
}
