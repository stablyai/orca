import { join } from 'node:path'

/**
 * Locates the vendored vscode-js-debug DAP bundle — downloaded by
 * `pnpm run ensure:debug-adapters` (config/scripts/vendor-js-debug-adapter.mjs)
 * to resources/debug-adapters/js-debug, shipped via extraResources in
 * packaged builds. Mirrors `resolveBundledPluginRoot`
 * (src/main/plugins/plugin-bundled-bootstrap.ts).
 */
export function resolveJsDebugAdapterRoot(options: {
  isPackaged: boolean
  resourcesPath: string
  appPath: string
}): string {
  return options.isPackaged
    ? join(options.resourcesPath, 'debug-adapters', 'js-debug')
    : join(options.appPath, 'resources', 'debug-adapters', 'js-debug')
}

export function resolveDapDebugServerEntrypoint(jsDebugAdapterRoot: string): string {
  return join(jsDebugAdapterRoot, 'src', 'dapDebugServer.js')
}
