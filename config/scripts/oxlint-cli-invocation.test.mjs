import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { resolveOxlintInvocation } from './oxlint-cli-invocation.mjs'

const repoRoot = path.resolve(import.meta.dirname, '..', '..')

describe('resolveOxlintInvocation', () => {
  it('runs oxlint under this process node, never through a shim', () => {
    const { command, prefixArgs } = resolveOxlintInvocation(repoRoot)

    expect(command).toBe(process.execPath)
    expect(prefixArgs).toHaveLength(1)
    // The EINVAL that killed the changed-code gate came from spawning a .cmd.
    expect(prefixArgs[0]).not.toMatch(/\.(cmd|bat)$/i)
    expect(existsSync(prefixArgs[0])).toBe(true)
  })

  it('spawns without a shell and produces Oxlint JSON', () => {
    const { command, prefixArgs } = resolveOxlintInvocation(repoRoot)
    const result = spawnSync(
      command,
      [...prefixArgs, '--help'],
      // shell:false is the point: the shim form throws EINVAL here on Windows.
      { cwd: repoRoot, encoding: 'utf8', shell: false, windowsHide: true }
    )

    expect(result.error).toBeUndefined()
    expect(result.stdout).toContain('oxlint')
  })
})
