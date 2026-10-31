import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const expoRequire = createRequire(require.resolve('expo'))
const cliRequire = createRequire(expoRequire.resolve('@expo/cli'))
const zodRoot = dirname(cliRequire.resolve('zod/package.json'))

describe.each(['cjs', 'js'])('installed Expo Zod (%s)', (extension) => {
  it.each(['index', 'v3/index', 'v4/index'])(
    'rejects oversized collections before parsing elements in %s',
    async (entry) => {
      const path = join(zodRoot, `${entry}.${extension}`)
      const z = extension === 'cjs' ? require(path) : await import(pathToFileURL(path).href)
      let parsed = 0
      let refined = 0
      const element = z.preprocess((value: unknown) => {
        parsed += 1
        return value
      }, z.string())
      const cases = [
        {
          schema: z.array(element).max(2, 'too many'),
          oversized: Array(1_000).fill(0),
          valid: ['a', 'b']
        },
        {
          schema: z.array(element).length(2, 'too many'),
          oversized: Array(1_000).fill(0),
          valid: ['a', 'b']
        },
        {
          schema: z.set(element).max(2, 'too many'),
          oversized: new Set(Array.from({ length: 1_000 }, (_, i) => i)),
          valid: new Set(['a', 'b'])
        },
        {
          schema: z.set(element).size(2, 'too many'),
          oversized: new Set(Array.from({ length: 1_000 }, (_, i) => i)),
          valid: new Set(['a', 'b'])
        }
      ]
      for (const { schema, oversized, valid } of cases) {
        const parent = z.object({ items: schema }).refine(() => {
          refined += 1
          return true
        })
        parsed = 0
        refined = 0
        for (const result of [
          parent.safeParse({ items: oversized }),
          await parent.safeParseAsync({ items: oversized })
        ]) {
          expect(result.success).toBe(false)
          expect(result.error.issues).toEqual([
            expect.objectContaining({ code: 'too_big', path: ['items'], message: 'too many' })
          ])
        }
        expect([parsed, refined]).toEqual([0, 0])
        expect(parent.parse({ items: valid })).toEqual({ items: valid })
        expect(await parent.parseAsync({ items: valid })).toEqual({ items: valid })
        expect(parsed).toBe(4)
      }
      expect(z.array(z.string()).max(2).safeParse([1]).success).toBe(false)
      expect(z.array(z.string()).length(2).safeParse(['a']).success).toBe(false)
      expect(
        z
          .set(z.string())
          .size(2)
          .safeParse(new Set(['a'])).success
      ).toBe(false)
      if (entry === 'v4/index') {
        expect(
          z
            .array(z.number())
            .overwrite((items: number[]) => items.slice(0, 2))
            .max(2)
            .parse([1, 2, 3])
        ).toEqual([1, 2])
      }
    }
  )

  it('protects the bundled Zod mini entrypoint', async () => {
    const path = join(zodRoot, `v4/mini/index.${extension}`)
    const z = extension === 'cjs' ? require(path) : await import(pathToFileURL(path).href)
    const schema = z.array(z.string()).check(z.maxLength(2))
    expect(z.safeParse(schema, [1, 2, 3]).error.issues).toEqual([
      expect.objectContaining({ code: 'too_big' })
    ])
    expect((await z.safeParseAsync(schema, [1, 2, 3])).error.issues).toHaveLength(1)
    expect(z.parse(schema, ['a'])).toEqual(['a'])
    const map = z.map(z.string(), z.string()).check(z.maxSize(1))
    const oversized = new Map([
      [1, 1],
      [2, 2]
    ])
    expect(z.safeParse(map, oversized).error.issues).toEqual([
      expect.objectContaining({ code: 'too_big' })
    ])
    expect((await z.safeParseAsync(map, oversized)).error.issues).toHaveLength(1)
    expect(z.parse(map, new Map([['a', 'b']]))).toEqual(new Map([['a', 'b']]))
  })
})
