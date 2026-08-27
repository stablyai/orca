import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Immutable build provenance, computed ONCE at build time and folded into the
 * bundle as a literal.
 *
 * Why not resolve this at runtime: a runtime that reads the checkout's current
 * HEAD reports whatever the tree happens to be at the moment it is asked, so a
 * build made at commit A starts claiming commit B the instant someone checks
 * out B. Certification evidence bound to that is meaningless. Baking the value
 * in at build time is what makes "the source this runtime was built from" a
 * fact about the artifact rather than about the working tree.
 *
 * `sourceSha` is null when there is no repository above the build (a packaged
 * artifact built elsewhere, or a folder workspace). Null is honest; a guessed
 * commit is not.
 */

const PROVENANCE_SCHEMA_VERSION = 1

function git(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch {
    return null
  }
}

export function readBuildProvenance(repoRoot = process.cwd()) {
  const root = resolve(repoRoot)
  const sourceSha = git(['rev-parse', 'HEAD'], root)
  // Why porcelain: a build from a dirty tree does not correspond to any commit,
  // and evidence must be able to say so rather than quietly citing the last one.
  const status = sourceSha === null ? null : git(['status', '--porcelain'], root)
  let version = '0.0.0'
  try {
    version = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version ?? '0.0.0'
  } catch {
    // Keep the placeholder; the caller still gets a usable record.
  }
  return {
    schemaVersion: PROVENANCE_SCHEMA_VERSION,
    sourceSha: sourceSha && /^[0-9a-f]{40}$/.test(sourceSha) ? sourceSha : null,
    dirty: status === null ? null : status.length > 0,
    appVersion: version,
    builtAt: new Date().toISOString()
  }
}

export function buildProvenanceLiteral(repoRoot = process.cwd()) {
  return JSON.stringify(JSON.stringify(readBuildProvenance(repoRoot)))
}
