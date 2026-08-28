import { createHash } from 'node:crypto'
import { runCommandForStdout } from './sync-command-output'
import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { resolveCommandOnLocalPathSync } from '../../../ipc/command-path-resolver'

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

export const MISSING_DEPENDENCY = 'absent'
export const UNREADABLE_DEPENDENCY = 'unreadable'

export function hashFileBytes(path: string, cwd: string): string {
  const absolute = isAbsolute(path) ? path : resolve(cwd, path)
  try {
    // Why stat first: a directory reads as unreadable rather than throwing on
    // some platforms, and "a directory is a dependency" is a caller mistake we
    // must record distinctly rather than silently fingerprint as empty.
    if (statSync(absolute).isDirectory()) {
      return UNREADABLE_DEPENDENCY
    }
    return createHash('sha256').update(readFileSync(absolute)).digest('hex').slice(0, 32)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? MISSING_DEPENDENCY
      : UNREADABLE_DEPENDENCY
  }
}

export type GateDependencySpec = {
  gateId: string
  /** Files this gate is sensitive to. Empty means it declared none. */
  files: readonly string[]
}

/** Expands the one repository-owned selector supported by the control plane.
 * `git:path` means every file tracked by Git under `path` at the current tree.
 * This keeps a manifest small while ensuring a newly added material source file
 * cannot be omitted by a completion caller. Plain entries remain exact files.
 */
export function resolveGateDependencyFiles(selectors: readonly string[], cwd: string): string[] {
  const files = new Set<string>()
  for (const selector of selectors) {
    if (!selector.startsWith('git:')) {
      files.add(selector)
      continue
    }
    const pathspec = selector.slice(4)
    if (!pathspec || pathspec.startsWith('/') || pathspec.split('/').includes('..')) {
      files.add(selector)
      continue
    }
    try {
      const output = runCommandForStdout({
        program: 'git',
        args: ['-C', cwd, 'ls-files', '-z', '--', pathspec]
      })
      for (const file of output.split('\0').filter(Boolean)) {
        files.add(file)
      }
    } catch {
      files.add(selector)
    }
  }
  return [...files].sort()
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
  /** The gate's declared executable. Every caller that derives this fingerprint
   *  from a required-gate SPEC must pass it, or the recorded and the verifying
   *  fingerprint will not match. */
  program?: string
}): Record<string, string> {
  const selectors = args.spec.files.length > 0 ? args.spec.files : args.fallbackFiles
  const files = resolveGateDependencyFiles(selectors, args.cwd)
  const hashes: Record<string, string> = {}
  for (const file of files) {
    const pinned = /^sha256:([a-f0-9]{64}):(.+)$/.exec(file)
    if (pinned) {
      const actual = hashFileBytes(pinned[2] as string, args.cwd)
      // `hashFileBytes` uses a compact digest for ordinary incremental inputs;
      // a pinned tool needs the complete digest so a modified ignored runner
      // can never be accepted as the committed toolchain.
      let full = UNREADABLE_DEPENDENCY
      try {
        const absolute = isAbsolute(pinned[2] as string)
          ? (pinned[2] as string)
          : resolve(args.cwd, pinned[2] as string)
        full = createHash('sha256').update(readFileSync(absolute)).digest('hex')
      } catch {
        full = actual
      }
      hashes[`tool:${pinned[2] as string}`] = full === pinned[1] ? full : UNREADABLE_DEPENDENCY
      continue
    }
    hashes[`file:${file}`] = hashFileBytes(file, args.cwd)
  }
  if (args.program) {
    // `commandIdentity` is a caller-declared label; it says nothing about which
    // binary PATH actually resolves to. Hash the bytes that will run, so a
    // PATH-shadowing impostor cannot inherit a genuine gate's receipt.
    const absolute = resolveCommandOnLocalPathSync(args.program, { cwd: args.cwd })
    hashes[`program:${absolute ?? args.program}`] = absolute
      ? hashFileBytes(absolute, args.cwd)
      : MISSING_DEPENDENCY
  }
  hashes['config:policyVersion'] = args.policyVersion
  hashes['config:commandIdentity'] = args.commandIdentity
  return hashes
}

/** A dependency the runtime could not actually read proves nothing about the
 *  gate. Two unreadable inputs compare EQUAL, so without this an unresolvable
 *  dependency set silently reads as "nothing changed" and every gate reuses. */
export function hasUnprovableDependency(hashes: Readonly<Record<string, string>>): string | null {
  for (const [key, value] of Object.entries(hashes)) {
    if (value === MISSING_DEPENDENCY || value === UNREADABLE_DEPENDENCY) {
      return key
    }
  }
  return null
}
