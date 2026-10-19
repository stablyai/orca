// SPDX-License-Identifier: MIT
// OpenCode v1.18.30 (5cd8e68): packages/opencode/src/plugin/shared.ts.
type PluginKind = 'server' | 'tui'
type PluginMode = 'strict' | 'detect'

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function readV1Plugin(
  mod: Record<string, unknown>,
  spec: string,
  kind: PluginKind,
  mode: PluginMode = 'strict'
) {
  const value = mod.default
  if (!isRecord(value)) {
    if (mode === 'detect') {
      return
    }
    throw new TypeError(`Plugin ${spec} must default export an object with ${kind}()`)
  }
  if (mode === 'detect' && !('id' in value) && !('server' in value) && !('tui' in value)) {
    return
  }

  const server = 'server' in value ? value.server : undefined
  const tui = 'tui' in value ? value.tui : undefined
  if (server !== undefined && typeof server !== 'function') {
    throw new TypeError(`Plugin ${spec} has invalid server export`)
  }
  if (tui !== undefined && typeof tui !== 'function') {
    throw new TypeError(`Plugin ${spec} has invalid tui export`)
  }
  if (server !== undefined && tui !== undefined) {
    throw new TypeError(`Plugin ${spec} must default export either server() or tui(), not both`)
  }
  if (kind === 'server' && server === undefined) {
    throw new TypeError(`Plugin ${spec} must default export an object with server()`)
  }
  if (kind === 'tui' && tui === undefined) {
    throw new TypeError(`Plugin ${spec} must default export an object with tui()`)
  }

  return value
}

// OpenCode v1.18.30 (5cd8e68): packages/opencode/src/plugin/index.ts.
type ServerPlugin = (...args: unknown[]) => unknown
function isServerPlugin(value: unknown): value is ServerPlugin {
  return typeof value === 'function'
}

function getServerPlugin(value: unknown) {
  if (isServerPlugin(value)) {
    return value
  }
  if (!value || typeof value !== 'object' || !('server' in value)) {
    return
  }
  if (!isServerPlugin(value.server)) {
    return
  }
  return value.server
}

export function getLegacyPlugins(mod: Record<string, unknown>) {
  const seen = new Set<unknown>()
  const result: ServerPlugin[] = []
  for (const entry of Object.values(mod)) {
    if (seen.has(entry)) {
      continue
    }
    seen.add(entry)
    const plugin = getServerPlugin(entry)
    if (!plugin) {
      throw new TypeError('Plugin export is not a function')
    }
    result.push(plugin)
  }
  return result
}
