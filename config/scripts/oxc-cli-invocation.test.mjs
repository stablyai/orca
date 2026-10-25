import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { resolveOxcCliInvocation } from './oxc-cli-invocation.mjs'
import { resolveOxlintInvocation } from './oxlint-cli-invocation.mjs'

const repoRoot = path.resolve(import.meta.dirname, '..', '..')

for (const { name, resolveInvocation } of [
  { name: 'oxfmt', resolveInvocation: () => resolveOxcCliInvocation('oxfmt', 'oxfmt', repoRoot) },
  { name: 'oxlint', resolveInvocation: () => resolveOxlintInvocation(repoRoot) }
]) {
  describe(`${name} CLI invocation`, () => {
    it('launches the installed CLI without a shell', () => {
      const { command, prefixArgs } = resolveInvocation()
      expect(command).toBe(process.execPath)
      expect(prefixArgs).toHaveLength(1)
      expect(prefixArgs[0]).not.toMatch(/\.(cmd|bat)$/i)
      expect(existsSync(prefixArgs[0])).toBe(true)
      const result = spawnSync(command, [...prefixArgs, '--help'], {
        cwd: repoRoot,
        encoding: 'utf8',
        shell: false,
        windowsHide: true
      })
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(0)
      expect(result.stdout).toContain(name)
    })
  })
}

it('names the package and bin it could not find', () => {
  expect(() => resolveOxcCliInvocation('oxfmt', 'nope', repoRoot)).toThrow(
    'oxfmt package.json declares no "nope" bin entry.'
  )
})
