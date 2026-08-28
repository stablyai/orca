import { runCommandForStdout } from './sync-command-output'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'
import { requiredGateSpecHash, type RequiredGateDefinition } from './required-gate-spec'

export const REQUIRED_GATE_CATALOG_PATH = '.orca/control-plane-gates.json'

const GateSchema = z.object({
  gateId: z.string().min(1),
  program: z.string().min(1),
  args: z.array(z.string()),
  dependencies: z.array(z.string().min(1)).min(1),
  policyVersion: z.string().min(1),
  commandIdentity: z.string().min(1),
  shaBinding: z.enum(['content', 'exact_head'])
})

const CatalogSchema = z.object({
  schemaVersion: z.literal(1),
  gates: z.array(GateSchema).min(1)
})

export type RequiredGateCatalog = {
  schemaVersion: 1
  sourcePath: string
  gates: ReadonlyMap<string, RequiredGateDefinition>
}

function git(args: readonly string[], cwd: string): string {
  return runCommandForStdout({ program: 'git', args: ['-C', cwd, ...args] })
}

/** Reads the gate meaning from the target repository's committed HEAD.
 *
 * The intake caller may select a gate id and may repeat its expected command as
 * a compatibility assertion. It cannot define the command or its dependency
 * set. The catalog must be tracked, byte-identical to HEAD, and the checkout
 * must not be modifying the catalog while admission runs. This is deliberately
 * much smaller than a build system: it is only a versioned mapping from ids to
 * commands and dependency selectors already reviewed with the repository.
 */
export function readRequiredGateCatalog(worktreePath: string): RequiredGateCatalog {
  const sourcePath = resolve(worktreePath, REQUIRED_GATE_CATALOG_PATH)
  const bytes = readFileSync(sourcePath, 'utf8')
  const committed = git(['show', `HEAD:${REQUIRED_GATE_CATALOG_PATH}`], worktreePath)
  if (bytes !== committed) {
    throw new Error('required_gate_catalog_not_at_head')
  }
  if (
    git(
      ['status', '--porcelain', '--untracked-files=all', '--', REQUIRED_GATE_CATALOG_PATH],
      worktreePath
    ).trim()
  ) {
    throw new Error('required_gate_catalog_dirty')
  }
  const parsed = CatalogSchema.parse(JSON.parse(bytes))
  const gates = new Map<string, RequiredGateDefinition>()
  for (const gate of parsed.gates) {
    if (gates.has(gate.gateId)) {
      throw new Error(`required_gate_catalog_duplicate:${gate.gateId}`)
    }
    for (const dependency of gate.dependencies) {
      const expectedDigest = /^sha256:([a-f0-9]{64}):(.+)$/.exec(dependency)
      const value = dependency.startsWith('git:')
        ? dependency.slice(4)
        : (expectedDigest?.[2] ?? dependency)
      if (!value || value.startsWith('/') || value.split('/').includes('..')) {
        throw new Error(`required_gate_dependency_unsafe:${dependency}`)
      }
    }
    gates.set(gate.gateId, gate)
  }
  return { schemaVersion: 1, sourcePath, gates }
}

export function exactGateAssertion(
  asserted: RequiredGateDefinition,
  catalog: RequiredGateCatalog
): RequiredGateDefinition {
  const canonical = catalog.gates.get(asserted.gateId)
  if (!canonical || requiredGateSpecHash(asserted) !== requiredGateSpecHash(canonical)) {
    throw new Error(`required_gate_assertion_mismatch:${asserted.gateId}`)
  }
  return canonical
}
