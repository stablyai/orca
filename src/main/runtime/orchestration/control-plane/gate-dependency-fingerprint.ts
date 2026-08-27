import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

/** Correction — a gate receipt is only as honest as what it fingerprints.
 *
 *  Hashing PATHS makes every receipt permanently reusable: the string never
 *  changes when the file does. These helpers hash the actual bytes, so editing
 *  a file invalidates exactly the gates that declared it, and a path whose
 *  contents changed can never masquerade as unchanged.
 *
 *  Gate configuration and version are fingerprinted alongside the files,
 *  because a gate whose command or policy changed is a different gate.
 */

const MISSING = 'absent'
const UNREADABLE = 'unreadable'

export function hashFileBytes(path: string, cwd: string): string {
  const absolute = isAbsolute(path) ? path : resolve(cwd, path)
  try {
    // Why stat first: a directory reads as unreadable rather than throwing on
    // some platforms, and "a directory is a dependency" is a caller mistake we
    // must record distinctly rather than silently fingerprint as empty.
    if (statSync(absolute).isDirectory()) {
      return UNREADABLE
    }
    return createHash('sha256').update(readFileSync(absolute)).digest('hex').slice(0, 32)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? MISSING : UNREADABLE
  }
}

export type GateDependencySpec = {
  gateId: string
  /** Files this gate is sensitive to. Empty means it declared none. */
  files: readonly string[]
}

/** `gateId` or `gateId=fileA|fileB` — the smallest syntax that lets one request
 *  declare a different dependency set per gate. */
export function parseGateDependencySpec(token: string): GateDependencySpec {
  const separator = token.indexOf('=')
  if (separator === -1) {
    return { gateId: token.trim(), files: [] }
  }
  return {
    gateId: token.slice(0, separator).trim(),
    files: token
      .slice(separator + 1)
      .split('|')
      .map((file) => file.trim())
      .filter(Boolean)
  }
}

/** The fingerprint for one gate: its own declared file bytes plus the gate
 *  configuration inputs that change what the gate means. */
export function fingerprintGateDependencies(args: {
  spec: GateDependencySpec
  /** Used when the gate declared no files of its own. */
  fallbackFiles: readonly string[]
  cwd: string
  policyVersion: string
  commandIdentity: string
}): Record<string, string> {
  const files = args.spec.files.length > 0 ? args.spec.files : args.fallbackFiles
  const hashes: Record<string, string> = {}
  for (const file of files) {
    hashes[`file:${file}`] = hashFileBytes(file, args.cwd)
  }
  hashes['config:policyVersion'] = args.policyVersion
  hashes['config:commandIdentity'] = args.commandIdentity
  return hashes
}
