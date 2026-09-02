import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { writeSecureFile } from '../../shared/secure-file'
import { isQualifiedPluginKey } from '../../shared/plugins/plugin-manifest'
import {
  PLUGIN_STORAGE_KEY_LIMIT,
  PLUGIN_STORAGE_TOTAL_MAX_BYTES,
  PLUGIN_STORAGE_VALUE_MAX_BYTES
} from '../../shared/plugins/plugin-host-api'

/**
 * Per-plugin JSON key-value persistence backing both `storage.*` (plugin
 * data) and `settings.*` (settings:own). Each plugin's data lives in its OWN
 * file under `<userData>/plugins-data/<publisher>.<id>/` — never a shared
 * namespaced blob, so one plugin's path can never resolve into another's.
 * Adapted from community PR #5801's per-plugin settings store.
 */

export function pluginDataDir(pluginsDataDir: string, qualifiedKey: string): string {
  if (!isQualifiedPluginKey(qualifiedKey)) {
    throw new Error(`unsafe plugin key: ${qualifiedKey}`)
  }
  return join(pluginsDataDir, qualifiedKey)
}

export type PluginKvWriteResult = { ok: true } | { ok: false; error: string }

export class PluginKvStore {
  private readonly filePath: string

  constructor(
    pluginsDataDir: string,
    qualifiedKey: string,
    fileName: 'storage.json' | 'settings.json'
  ) {
    this.filePath = join(pluginDataDir(pluginsDataDir, qualifiedKey), fileName)
  }

  private read(): Record<string, unknown> {
    try {
      if (!existsSync(this.filePath)) {
        return {}
      }
      if (statSync(this.filePath).size > PLUGIN_STORAGE_TOTAL_MAX_BYTES) {
        return {}
      }
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // Corrupt files reset to empty rather than wedging the plugin.
    }
    return {}
  }

  get(key: string): unknown {
    return this.read()[key]
  }

  getAll(): Record<string, unknown> {
    return this.read()
  }

  keys(): string[] {
    return Object.keys(this.read())
  }

  set(key: string, value: unknown): PluginKvWriteResult {
    let serialized: string
    try {
      serialized = JSON.stringify(value)
    } catch {
      return { ok: false, error: 'value is not JSON-serializable' }
    }
    if (serialized === undefined) {
      return { ok: false, error: 'value is not JSON-serializable' }
    }
    if (Buffer.byteLength(serialized, 'utf8') > PLUGIN_STORAGE_VALUE_MAX_BYTES) {
      return { ok: false, error: `value exceeds ${PLUGIN_STORAGE_VALUE_MAX_BYTES} bytes` }
    }
    const settings = this.read()
    if (!Object.hasOwn(settings, key) && Object.keys(settings).length >= PLUGIN_STORAGE_KEY_LIMIT) {
      return { ok: false, error: `storage exceeds the ${PLUGIN_STORAGE_KEY_LIMIT}-key limit` }
    }
    settings[key] = value
    const nextFile = JSON.stringify(settings, null, 2)
    if (Buffer.byteLength(nextFile, 'utf8') > PLUGIN_STORAGE_TOTAL_MAX_BYTES) {
      return { ok: false, error: `storage exceeds ${PLUGIN_STORAGE_TOTAL_MAX_BYTES} bytes` }
    }
    writeSecureFile(this.filePath, nextFile)
    return { ok: true }
  }

  delete(key: string): void {
    const settings = this.read()
    if (Object.hasOwn(settings, key)) {
      delete settings[key]
      writeSecureFile(this.filePath, JSON.stringify(settings, null, 2))
    }
  }
}
