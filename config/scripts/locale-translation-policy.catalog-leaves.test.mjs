import { describe, expect, it } from 'vitest'

import { collectInterpolationVariables, setLeaf } from './locale-translation-policy.mjs'

// Why: locale-translation-policy.test.mjs sits at the 600-line budget, so the leaf helpers test here.
describe('locale-translation-policy catalog leaves', () => {
  it('collects placeholders sorted and with repeats kept', () => {
    expect(collectInterpolationVariables('Hi {{z}} {{a}} {{z}}')).toEqual([
      '{{a}}',
      '{{z}}',
      '{{z}}'
    ])
    expect(collectInterpolationVariables({ a: 'x {{b}}', c: { d: '{{a}}' } })).toEqual([
      '{{b}}',
      '{{a}}'
    ])
    expect(collectInterpolationVariables(42)).toEqual([])
  })

  it('creates missing containers and refuses prototype-polluting paths', () => {
    const catalog = { section: { kept: 'Kept' } }
    setLeaf(catalog, 'section.title', 'Title')
    setLeaf(catalog, 'fresh.nested.leaf', 'Leaf')
    expect(catalog).toEqual({
      section: { kept: 'Kept', title: 'Title' },
      fresh: { nested: { leaf: 'Leaf' } }
    })
    expect(() => setLeaf(catalog, 'foo.__proto__.title', 'Polluted')).toThrow('unsafe catalog path')
    expect(() => setLeaf(catalog, 'constructor.x', 'Polluted')).toThrow('unsafe catalog path')
    expect({}.title).toBeUndefined()
  })
})
