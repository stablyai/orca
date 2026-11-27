import { expect, it } from 'vitest'
import { parseGlabPaginationHeader } from './glab-api-response'

it('rejects numeric prefixes that cannot establish a complete pagination count', () => {
  expect(parseGlabPaginationHeader('1e2', 1)).toBeUndefined()
  expect(parseGlabPaginationHeader('12, 12', 1)).toBeUndefined()
  expect(parseGlabPaginationHeader(' 12 ', 1)).toBe(12)
  expect(parseGlabPaginationHeader('0', 0)).toBe(0)
})
