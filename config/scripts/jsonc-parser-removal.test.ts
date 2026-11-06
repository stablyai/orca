import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser/lib/esm/main.js'
import { expect, it } from 'vitest'

it.each([
  { text: '[{"a":1},{"b":2}]', path: [1], expected: [{ a: 1 }] },
  { text: '[1,2]', path: [1], expected: [1] },
  { text: '{"a":1 /* user comment */,}', path: ['a'], expected: {} }
])('removes $path from $text using the shipped ESM entry', ({ text, path, expected }) => {
  const output = applyEdits(text, modify(text, path, undefined, {}))
  const errors: ParseError[] = []
  expect(parse(output, errors, { allowTrailingComma: true })).toEqual(expected)
  expect(errors).toEqual([])
})
