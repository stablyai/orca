import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { resolveOxcCliInvocation } from './oxc-cli-invocation.mjs'

const repoRoot = path.resolve(import.meta.dirname, '..', '..')

describe('resolveOxcCliInvocation', () => {
  it('runs oxfmt under this process node, never through a shim', () => {
    const { command, prefixArgs } = resolveOxcCliInvocation('oxfmt', 'oxfmt', repoRoot)

    expect(command).toBe(process.execPath)
    expect(prefixArgs).toHaveLength(1)
    // The params-catalog generator spawned node_modules/.bin/oxfmt, which is a .cmd on
    // Windows — Node >= 20 refuses it without shell:true and dies with EINVAL.
    expect(prefixArgs[0]).not.toMatch(/\.(cmd|bat)$/i)
    expect(existsSync(prefixArgs[0])).toBe(true)
  })

  it('spawns oxfmt without a shell', () => {
    const { command, prefixArgs } = resolveOxcCliInvocation('oxfmt', 'oxfmt', repoRoot)
    const result = spawnSync(command, [...prefixArgs, '--help'], {
      cwd: repoRoot,
      encoding: 'utf8',
      shell: false,
      windowsHide: true
    })

    expect(result.error).toBeUndefined()
    expect(result.stdout).toContain('oxfmt')
  })

  it('names the package and bin it could not find', () => {
    expect(() => resolveOxcCliInvocation('oxfmt', 'nope', repoRoot)).toThrow(
      'oxfmt package.json declares no "nope" bin entry.'
    )
  })
})
