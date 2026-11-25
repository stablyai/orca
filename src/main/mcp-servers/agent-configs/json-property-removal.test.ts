import { describe, expect, it } from 'vitest'
import { insertJsonProperties } from './json-property-insertion'
import { removeJsonProperties, removeJsonProperty } from './json-property-removal'

describe('removeJsonProperty', () => {
  it('removes the property and its comma, keeping the rest as written', () => {
    const text = '{\n  // servers\n  "a": { "x": 1 },\n  "b": 2,\n  "c": [\n    3\n  ]\n}\n'
    expect(removeJsonProperty(text, ['a'])).toBe(
      '{\n  // servers\n  "b": 2,\n  "c": [\n    3\n  ]\n}\n'
    )
    expect(removeJsonProperty(text, ['c'])).toBe(
      '{\n  // servers\n  "a": { "x": 1 },\n  "b": 2\n}\n'
    )
    expect(removeJsonProperty('{ "a": 1, "b": 2 }', ['a'])).toBe('{ "b": 2 }')
    expect(removeJsonProperty('{ "a": 1, "b": 2 }', ['b'])).toBe('{ "a": 1 }')
    expect(removeJsonProperty('{\n\t"o": {\n\t\t"only": true\n\t}\n}', ['o', 'only'])).toBe(
      '{\n\t"o": {\n\t}\n}'
    )
    expect(removeJsonProperty('{ "a": 1 }', ['missing'])).toBe('{ "a": 1 }')
  })
})

describe('removeJsonProperties', () => {
  const texts = [
    '{\n  "s": {\n    // mine\n    "a": 1,\n    "b": { "x": [1] },\n    "c": 3,\n    "d": 4,\n  }\n}\n',
    '{ "s": { "a": 1, "b": 2, "c": 3, "d": 4 } }',
    '{\r\n\t"s": {\r\n\t\t"a": 1, // one\r\n\t\t"b": 2,\r\n\t\t"c": 3,\r\n\t\t"d": 4\r\n\t}\r\n}'
  ]
  const subsets = [
    ['a'],
    ['d'],
    ['b', 'c'],
    ['c', 'd'],
    ['a', 'b', 'c', 'd'],
    ['a', 'c'],
    ['b', 'd']
  ]

  it('takes out several properties exactly as removing them one at a time would', () => {
    for (const text of texts) {
      for (const names of subsets) {
        const oneByOne = names.reduce((next, name) => removeJsonProperty(next, ['s', name]), text)
        expect(removeJsonProperties(text, ['s'], names)).toBe(oneByOne)
      }
    }
  })

  it('takes back exactly what insertJsonProperties added', () => {
    const added = [
      ['e', { command: 'orca', args: ['mcp', 'connect'] }],
      ['f', 2]
    ] as const
    // The first text's trailing comma moves; the others come back byte for byte.
    for (const text of texts.slice(1)) {
      const inserted = insertJsonProperties(text, ['s'], added)!
      expect(removeJsonProperties(inserted, ['s'], ['e', 'f'])).toBe(text)
    }
  })
})
