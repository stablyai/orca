import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Guard the removal of `ResolvedRuntimeFileTarget.connectionId` at the tree level.
 *
 * Removing the field is what turned every reader into an error rather than letting old call sites
 * silently inherit a changed meaning — the way this defect spread. But the whole
 * `runtime-file-commands-*` family carries `// @ts-nocheck` from a mechanical class split, so the
 * compiler reports nothing there: a re-introduced `target.connectionId` would read `undefined`,
 * which is exactly the "unresolved means local" spelling the migration deleted (#11163).
 *
 * This test is the compile error those files cannot produce. Routing goes through
 * `runtime-file-command-target.ts`, which is deliberately not `@ts-nocheck`.
 */
const RUNTIME_DIR = __dirname
const TARGET_MODULE = 'runtime-file-command-target.ts'

// Matches `target.connectionId`, `tempTarget.connectionId`, `knownWorkspaceTarget?.connectionId`.
// Not `grant.connectionId` or `args.connectionId`: a grant and a leaf argument legitimately carry
// an SSH target id, having already been resolved from a host.
const TARGET_CONNECTION_READ = /\b\w*[Tt]arget\??\.connectionId\b/

function familyFiles(): string[] {
  return readdirSync(RUNTIME_DIR).filter(
    (name) =>
      (name.startsWith('runtime-file-') || name === 'orca-runtime-file-commands.ts') &&
      name.endsWith('.ts') &&
      !name.endsWith('.test.ts')
  )
}

describe('runtime file target connection field', () => {
  it('is read nowhere in the runtime file command family', () => {
    const offenders = familyFiles().filter((name) =>
      TARGET_CONNECTION_READ.test(readFileSync(join(RUNTIME_DIR, name), 'utf8'))
    )

    expect(offenders).toEqual([])
  })

  // The one module in the family the compiler still checks; it is where the routing rule lives.
  it('routes through a module the compiler still checks', () => {
    const source = readFileSync(join(RUNTIME_DIR, TARGET_MODULE), 'utf8')

    expect(source).not.toMatch(/@ts-nocheck/)
    expect(source).toMatch(/executionHostId: ExecutionHostId/)
  })
})
