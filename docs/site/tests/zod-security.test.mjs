import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const vercelRequire = createRequire(require.resolve('vercel/package.json'))
const backendsRequire = createRequire(vercelRequire.resolve('@vercel/backends/package.json'))
const zodRoot = dirname(backendsRequire.resolve('zod/package.json'))

for (const extension of ['cjs', 'js']) {
  for (const entry of ['index', 'v3/index', 'v4/index']) {
    test(`Vercel Zod rejects oversized collections before parsing elements (${entry}.${extension})`, async () => {
      const path = join(zodRoot, `${entry}.${extension}`)
      const z = extension === 'cjs' ? require(path) : await import(pathToFileURL(path).href)
      let parsed = 0
      const element = z.preprocess((value) => {
        parsed += 1
        return value
      }, z.string())
      for (const [schema, value, valid] of [
        [z.array(element).max(2), Array(1_000).fill(0), ['a']],
        [z.array(element).length(2), Array(1_000).fill(0), ['a', 'b']],
        [z.set(element).max(2), new Set([1, 2, 3]), new Set(['a'])],
        [z.set(element).size(2), new Set([1, 2, 3]), new Set(['a', 'b'])]
      ]) {
        parsed = 0
        for (const result of [schema.safeParse(value), await schema.safeParseAsync(value)]) {
          assert.equal(result.success, false)
          assert.deepEqual(
            result.error.issues.map((issue) => issue.code),
            ['too_big']
          )
        }
        assert.equal(parsed, 0)
        assert.deepEqual(schema.parse(valid), valid)
        assert.deepEqual(await schema.parseAsync(valid), valid)
      }
    })
  }
}

test('docs Zod 4 keeps valid schemas working after the security upgrade', async () => {
  const { z } = await import('zod')
  const schema = z.array(z.string()).max(2)
  assert.deepEqual(schema.parse(['a']), ['a'])
  assert.deepEqual(
    schema.safeParse([1, 2, 3]).error.issues.map((issue) => issue.code),
    ['too_big']
  )
})
