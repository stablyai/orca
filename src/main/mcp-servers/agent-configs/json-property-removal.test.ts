import { describe, expect, it } from 'vitest'
import { removeJsonProperty } from './json-property-removal'

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
