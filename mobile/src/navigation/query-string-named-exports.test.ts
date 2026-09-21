import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * expo-router and React Navigation serialise route params through `import * as queryString from
 * 'query-string'`. The lockfile overrides `query-string` to 9.x for a `decode-uri-component`
 * advisory, and 9.x's entry has a default export only, so without `patches/query-string@9.5.1.patch`
 * every push carrying a param outside the path pattern throws `queryString.stringify is not a
 * function` and every href with a query throws on `parse`. Resolved from expo-router's own location,
 * the way Metro and the web bundler resolve it for that consumer, and imported by a plain Node
 * child: vitest's default-export interop would paper over the missing names in-process.
 */
describe('query-string, as expo-router resolves it', () => {
  it('exposes the named API the namespace import needs', () => {
    const requireFromHere = createRequire(import.meta.url)
    const requireFromExpoRouter = createRequire(requireFromHere.resolve('expo-router/package.json'))
    const entry = pathToFileURL(requireFromExpoRouter.resolve('query-string')).href
    const script = `const ns = await import(${JSON.stringify(entry)}); process.stdout.write(JSON.stringify({ names: Object.keys(ns).sort(), stringified: typeof ns.stringify === 'function' ? ns.stringify({ from: 'worktrees' }) : null }))`
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8'
    })
    const { names, stringified } = JSON.parse(output)
    expect(names).toEqual(expect.arrayContaining(['parse', 'stringify']))
    expect(stringified).toBe('from=worktrees')
  })
})
