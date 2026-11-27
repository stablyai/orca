import { expect, it } from 'vitest'
import { extractUrlCandidates } from './advertised-url-parsing'

it('keeps the closing bracket of IPv6 hosts while trimming trailing punctuation', () => {
  expect(
    extractUrlCandidates(
      'http://[::1] (http://[::1]). [https://[::1]] http://localhost] http://[::1]/x]'
    ).map(String)
  ).toEqual([
    'http://[::1]/',
    'http://[::1]/',
    'https://[::1]/',
    'http://localhost/',
    'http://[::1]/x'
  ])
})
