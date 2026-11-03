import { readFile, stat } from 'node:fs/promises'

// Bound config reads to avoid loading arbitrarily large files into main.
export const MAX_CONFIG_BYTES = 1_000_000

export type ConfigFileRead =
  | { ok: true; content: string }
  | { ok: false; error: string; missing?: boolean }

export async function readConfigFile(configPath: string): Promise<ConfigFileRead> {
  try {
    const info = await stat(configPath)
    // Picked paths can be devices or FIFOs whose zero size would slip past the byte limit.
    if (!info.isFile()) {
      return { ok: false, error: 'Config path is not a regular file.' }
    }
    if (info.size > MAX_CONFIG_BYTES) {
      return {
        ok: false,
        error: `Config file is too large to import (${info.size} bytes, limit ${MAX_CONFIG_BYTES}).`
      }
    }
    return { ok: true, content: await readFile(configPath, 'utf-8') }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Could not read config file'
    const missing = err instanceof Error && 'code' in err && err.code === 'ENOENT'
    return {
      ok: false,
      error: `Could not read config: ${message}`,
      ...(missing ? { missing } : {})
    }
  }
}
