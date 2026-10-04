/**
 * The bundled ConPTY a pinned-Node relay ships in its node-pty slot (design D2): conpty.dll plus
 * OpenConsole.exe, the pair the desktop daemon already spawns through (`useConptyDll`).
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { RelayRuntimeKind } from '../shared/relay-runtime-self-test-report'

export const RELAY_BUNDLED_CONPTY_FILES = ['conpty/conpty.dll', 'conpty/OpenConsole.exe'] as const

export function relayBundledConptyPaths(nodePtyDir: string): string[] {
  return RELAY_BUNDLED_CONPTY_FILES.map((file) =>
    join(nodePtyDir, 'build', 'Release', ...file.split('/'))
  )
}

/**
 * Only a pinned-Node relay opts in: its slot always carries the bundled pair, while a host-Node
 * relay's npm tree keeps the inbox ConPTY it has always used.
 */
export function relayConptyDllSpawnOptions(
  nodePtyDir: string,
  runtimeKind: RelayRuntimeKind,
  platform: NodeJS.Platform = process.platform
): { useConptyDll: true } | Record<string, never> {
  if (platform !== 'win32' || runtimeKind !== 'pinned-node') {
    return {}
  }
  return relayBundledConptyPaths(nodePtyDir).every((path) => existsSync(path))
    ? { useConptyDll: true }
    : {}
}
