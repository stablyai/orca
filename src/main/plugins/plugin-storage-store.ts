import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { isUnreadableError, writeSecureFile } from '../../shared/secure-file'
import { isQualifiedPluginKey } from '../../shared/plugins/manifest/plugin-manifest'
import {
  PLUGIN_STORAGE_KEY_LIMIT,
  PLUGIN_STORAGE_TOTAL_MAX_BYTES,
  PLUGIN_STORAGE_VALUE_MAX_BYTES,
  type PluginJsonValue
} from '../../shared/plugins/workers/plugin-host-api'

// Keep plugin data/settings in separate qualified-key files (adapted from community PR #5801).

const UNREADABLE_STORE_ERROR = 'storage file exists but could not be read; refusing to overwrite it'

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

  /** Null means unreadable, never empty. */
  private read(): Record<string, PluginJsonValue> | null {
    try {
      if (!existsSync(this.filePath)) {
        return {}
      }
      if (statSync(this.filePath).size > PLUGIN_STORAGE_TOTAL_MAX_BYTES) {
        return {}
      }
      const parsed: PluginJsonValue = JSON.parse(readFileSync(this.filePath, 'utf8'))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed
      }
    } catch (error) {
      // Read denial cannot prove corruption; rewriting an empty store would discard existing keys.
      if (isUnreadableError(error)) {
        return null
      }
      // Corrupt files reset to empty rather than wedging the plugin.
    }
    return {}
  }

  get(key: string): PluginJsonValue | undefined {
    return this.read()?.[key]
  }

  getAll(): Record<string, PluginJsonValue> {
    return this.read() ?? {}
  }

  keys(): string[] {
    return Object.keys(this.read() ?? {})
  }

  set(key: string, value: PluginJsonValue): PluginKvWriteResult {
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
    if (!settings) {
      return { ok: false, error: UNREADABLE_STORE_ERROR }
    }
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
    if (!settings) {
      // Rewriting what we could not read would drop every other key in the store.
      return
    }
    if (Object.hasOwn(settings, key)) {
      delete settings[key]
      writeSecureFile(this.filePath, JSON.stringify(settings, null, 2))
    }
  }
}
