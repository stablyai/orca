import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

// Plain Node preserves the namespace import used by Expo Router and React Navigation.
// Vitest's default-export interop can hide missing names in the overridden query-string 9.x.
describe('query-string, as expo-router resolves it', () => {
  it('exposes the named API the namespace import needs', () => {
    const requireFromHere = createRequire(import.meta.url)
    const requireFromExpoRouter = createRequire(requireFromHere.resolve('expo-router/package.json'))
    const entry = pathToFileURL(requireFromExpoRouter.resolve('query-string')).href
    const script = `const ns = await import(${JSON.stringify(entry)}); process.stdout.write(JSON.stringify({ stringified: ns.stringify({ from: 'worktrees', hostId: 'host/one' }), parsed: ns.parse('from=worktrees&hostId=host%2Fone') }))`
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8'
    })
    const { stringified, parsed } = JSON.parse(output)
    expect(stringified).toBe('from=worktrees&hostId=host%2Fone')
    expect(parsed).toEqual({ from: 'worktrees', hostId: 'host/one' })
  })
})
