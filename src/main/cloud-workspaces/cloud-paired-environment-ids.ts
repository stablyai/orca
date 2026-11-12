// Which saved servers are PAIRED Orca Cloud workspaces (PAIRED-AWARE). Opening a cloud workspace this
// desktop didn't create (another device, a teammate's, a link, or one started from a GitHub-only repo)
// pairs this device as a "<name> (cloud)" server and records sandbox -> environment in the bindings
// file. The runtime catalog marks those servers so every Orca Cloud check treats them like this
// desktop's own sandboxes.
//
// Held in memory: the pairings module reports every bindings read and write here (no sync file reads
// on the main thread), and the catalog republishes when the set changes.
import { join } from 'node:path'

export const CLOUD_PAIRING_BINDINGS_FILE = 'cloud-workspaces-environments.json'

export function cloudPairingBindingsPath(userDataPath: string): string {
  return join(userDataPath, CLOUD_PAIRING_BINDINGS_FILE)
}

let pairedSandboxByEnvironment: ReadonlyMap<string, string> = new Map()

/** The bindings as last read or written (sandbox id -> { environmentId }). Returns true on a change. */
export function noteCloudPairingBindings(
  bindings: Readonly<Record<string, { environmentId: string }>>
): boolean {
  const next = new Map<string, string>()
  for (const [sandboxId, binding] of Object.entries(bindings)) {
    if (binding?.environmentId) {
      next.set(binding.environmentId, sandboxId)
    }
  }
  const changed =
    next.size !== pairedSandboxByEnvironment.size ||
    [...next].some(
      ([environmentId, sandboxId]) => pairedSandboxByEnvironment.get(environmentId) !== sandboxId
    )
  pairedSandboxByEnvironment = next
  return changed
}

/** Paired environment id -> its sandbox id. */
export function cloudPairedSandboxesByEnvironment(): ReadonlyMap<string, string> {
  return pairedSandboxByEnvironment
}

/** Environment ids bound to a cloud pairing. */
export function cloudPairedEnvironmentIds(): ReadonlySet<string> {
  return new Set(pairedSandboxByEnvironment.keys())
}
