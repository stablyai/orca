import type * as HtmlParser from 'hast-util-from-html-isomorphic'
import type { Root, RootContent } from 'hast'
import { describe, expect, it, vi } from 'vitest'
const traversal = vi.hoisted(() => ({ enabled: false, parses: 0, children: 0 }))
vi.mock('hast-util-from-html-isomorphic', async (load) => {
  const actual = await load<typeof HtmlParser>()
  return {
    ...actual,
    fromHtmlIsomorphic: (...args: Parameters<typeof actual.fromHtmlIsomorphic>) => {
      const tree = actual.fromHtmlIsomorphic(...args)
      if (!traversal.enabled) {
        return tree
      }
      traversal.parses++
      const pending: (Root | RootContent)[] = [tree]
      while (pending.length) {
        const node = pending.pop()!
        if (!('children' in node)) {
          continue
        }
        const children = node.children
        pending.push(...children)
        Object.defineProperty(node, 'children', {
          get: () => {
            traversal.children++
            return children
          }
        })
      }
      return tree
    }
  }
})
import { githubBodyImageUrls } from './body-image-urls'

const original = 'https://github.com/user-attachments/assets/ce11040a-fb66-4289-927f-547b16dfc488'
const signed =
  'https://private-user-images.githubusercontent.com/1/2-ce11040a-fb66-4289-927f-547b16dfc488.png?jwt=TEST&download=1'

describe('GitHub body image sources', () => {
  it('matches rendered images to canonical assets without changing editable Markdown', () => {
    const body = `![shot](${original})\n<img src="https://github.enterprise/team/repo/assets/42/ab11040a-fb66-4289-927f-547b16dfc488">\n![missing](https://github.com/user-attachments/assets/cc11040a-fb66-4289-927f-547b16dfc488)\n\`https://github.com/user-attachments/assets/dd11040a-fb66-4289-927f-547b16dfc488\``
    const html = `<img src="https://private-user-images.githubusercontent.com/1/2-ce11040a-fb66-4289-927f-547b16dfc488.png?jwt=TEST&amp;download=1"><img src="https://github.enterprise/storage/ab11040a-fb66-4289-927f-547b16dfc488.png?jwt=TEST"><code>https://private-user-images.githubusercontent.com/1/dd11040a-fb66-4289-927f-547b16dfc488.png</code>`
    expect(githubBodyImageUrls(body, html)).toEqual({
      'https://github.com/user-attachments/assets/ce11040a-fb66-4289-927f-547b16dfc488': signed,
      'https://github.enterprise/team/repo/assets/42/ab11040a-fb66-4289-927f-547b16dfc488':
        'https://github.enterprise/storage/ab11040a-fb66-4289-927f-547b16dfc488.png?jwt=TEST'
    })
    expect(githubBodyImageUrls(body, undefined)).toBeUndefined()
    expect(githubBodyImageUrls(`![public](${original})`, `<img src="${original}">`)).toBeUndefined()
    expect(
      githubBodyImageUrls(
        body,
        '<img src="https://unrelated.example/ce11040a-fb66-4289-927f-547b16dfc488.png">'
      )
    ).toBeUndefined()
  })

  it('bounds candidate validation and indexed lookups at N and 10N', () => {
    for (const n of [100, 1000]) {
      const ids = Array.from(
        { length: n },
        (_, i) => `ce11040a-fb66-4289-927f-${String(i).padStart(12, '0')}`
      )
      const body = ids
        .map((id) => `![shot](https://github.com/user-attachments/assets/${id})`)
        .join('\n')
      const html = ids
        .map(
          (id) =>
            `<img src="https://private-user-images.githubusercontent.com/1/${id}.png?jwt=TEST">`
        )
        .join('\n')
      traversal.enabled = true
      traversal.parses = 0
      traversal.children = 0
      const pathname = vi.spyOn(URL.prototype, 'pathname', 'get')
      const originalGet = Map.prototype.get
      let lookups = 0
      Map.prototype.get = function (this: Map<unknown, unknown>, key: unknown) {
        if (typeof key === 'string' && key.startsWith('ce11040a-')) {
          lookups++
        }
        return originalGet.call(this, key)
      }
      try {
        const result = githubBodyImageUrls(body, html)
        expect(Object.keys(result ?? {})).toHaveLength(n)
        // Each candidate and original is checked once, then each original gets one indexed lookup.
        expect(pathname.mock.calls.length).toBeLessThanOrEqual(3 * n)
        expect(lookups).toBe(n)
        expect(traversal.parses).toBe(1)
        expect(traversal.children).toBeLessThanOrEqual(n + 1)
        expect(
          result?.[
            'https://github.com/user-attachments/assets/ce11040a-fb66-4289-927f-000000000000'
          ]
        ).toBe(
          'https://private-user-images.githubusercontent.com/1/ce11040a-fb66-4289-927f-000000000000.png?jwt=TEST'
        )
      } finally {
        traversal.enabled = false
        Map.prototype.get = originalGet
        pathname.mockRestore()
      }
    }
  })
})
