import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { hasEnvironmentBuildMarker, isEnvironmentBuildCheckout } from './environment-build-checkout'

describe('environment build checkout marker', () => {
  it('recognises a built primary checkout and its linked worktrees, and nothing else', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-env-build-'))
    const primary = join(root, 'repo')
    const commonDir = join(primary, '.git')
    mkdirSync(join(commonDir, 'worktrees', 'wt'), { recursive: true })
    const worktree = join(root, 'wt')
    mkdirSync(worktree)
    writeFileSync(join(worktree, '.git'), `gitdir: ${join(commonDir, 'worktrees', 'wt')}\n`)
    writeFileSync(join(commonDir, 'worktrees', 'wt', 'commondir'), '../..\n')
    expect(isEnvironmentBuildCheckout(primary)).toBe(false)
    expect(isEnvironmentBuildCheckout(worktree)).toBe(false)
    writeFileSync(join(commonDir, 'orca-env-deps'), 'node_modules\n')
    expect(isEnvironmentBuildCheckout(primary)).toBe(true)
    expect(isEnvironmentBuildCheckout(worktree)).toBe(true)
    expect(hasEnvironmentBuildMarker('.git', primary)).toBe(true)
    expect(isEnvironmentBuildCheckout(join(root, 'missing'))).toBe(false)
  })
})
