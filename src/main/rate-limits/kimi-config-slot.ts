import { readFile } from 'node:fs/promises'
import { getKimiConfigPath, parseKimiActiveOAuthSlot } from '../kimi/kimi-oauth-slot'
import {
  createAuthFilesystemOperation,
  type SharedAuthFilesystemOperation
} from './auth-filesystem-operation'

const CONFIG_READ_TIMEOUT_MS = 5_000

/**
 * Scoped slots discovered per Kimi home, so steady-state polls read exactly
 * one file (the active slot) instead of probing config.toml every cycle. The
 * cache is best-effort: callers drop an entry as soon as its slot file stops
 * yielding credentials, and lazy re-discovery is one poll away.
 */
const activeSlotByHome = new Map<string, string>()

export function getCachedKimiSlot(kimiHome: string): string | null {
  return activeSlotByHome.get(kimiHome) ?? null
}

export function setCachedKimiSlot(kimiHome: string, slot: string): void {
  activeSlotByHome.set(kimiHome, slot)
}

export function clearCachedKimiSlot(kimiHome: string): void {
  activeSlotByHome.delete(kimiHome)
}

const configSlotReadByPath = new Map<string, SharedAuthFilesystemOperation<string | null>>()

function getConfigSlotRead(path: string): SharedAuthFilesystemOperation<string | null> {
  const existing = configSlotReadByPath.get(path)
  if (existing) {
    return existing
  }
  const read = createAuthFilesystemOperation(path, async (): Promise<string | null> => {
    let raw: string
    try {
      raw = await readFile(path, 'utf-8')
    } catch {
      return null
    }
    return parseKimiActiveOAuthSlot(raw)
  })
  configSlotReadByPath.set(path, read)
  const clearRead = (): void => {
    if (configSlotReadByPath.get(path) === read) {
      configSlotReadByPath.delete(path)
    }
  }
  void read.result.then(clearRead, clearRead)
  return read
}

/**
 * Bounded read of the active OAuth slot recorded in <kimi home>/config.toml,
 * for the lazy path where the default slot proved missing or stale. Shares
 * one in-flight read per path and serializes with the credential read on the
 * same WSL distro lane, so a stopped distro still parks at most one read at
 * a time — identical footprint to the pre-probe behavior. Resolves to null —
 * the historical default slot — on any read failure or timeout.
 */
export async function readKimiActiveOAuthSlot(kimiHome: string): Promise<string | null> {
  try {
    return await getConfigSlotRead(getKimiConfigPath(kimiHome)).wait(
      AbortSignal.timeout(CONFIG_READ_TIMEOUT_MS)
    )
  } catch {
    return null
  }
}
