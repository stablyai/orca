import { describe, expect, it } from 'vitest'
import { parseDnrRedirect, transformDnrUrl } from './redirect-url'
import { isDnrRuleProblem } from '../rule-compilation/parse-errors'
import type { DnrUrlTransform } from '../rule-compilation/rule-types'

function transform(url: string, spec: DnrUrlTransform): string | null {
  const parsed = parseDnrRedirect({ transform: spec }, 1, 'ext')
  if (isDnrRuleProblem(parsed) || parsed.kind !== 'transform') {
    throw new Error('bad transform')
  }
  return transformDnrUrl(url, parsed.transform)
}

describe('transformDnrUrl', () => {
  // GetModifiedQuery: removals and replacements keep the original order; additions go last.
  it.each<[string, DnrUrlTransform['queryTransform'], string]>([
    [
      'http://a.com/?a=1&utm_source=x&b=2',
      { removeParams: ['utm_source'] },
      'http://a.com/?a=1&b=2'
    ],
    ['http://a.com/?utm_source=x', { removeParams: ['utm_source'] }, 'http://a.com/'],
    [
      'http://a.com/?a=1&a=2',
      { addOrReplaceParams: [{ key: 'a', value: 'z' }] },
      'http://a.com/?a=z&a=2'
    ],
    [
      'http://a.com/?a=1',
      { addOrReplaceParams: [{ key: 'b', value: 'c d' }] },
      'http://a.com/?a=1&b=c+d'
    ],
    [
      'http://a.com/?a=1',
      { addOrReplaceParams: [{ key: 'b', value: '1', replaceOnly: true }] },
      'http://a.com/?a=1'
    ],
    // Chromium writes every surviving pair back as key=value.
    ['http://a.com/?flag&x=1', { removeParams: ['x'] }, 'http://a.com/?flag='],
    ['http://a.com/?a=1&&b=2', { removeParams: ['b'] }, 'http://a.com/?a=1&='],
    ['http://a.com/?a=1', { removeParams: ['zzz'] }, 'http://a.com/?a=1']
  ])('%s with %j → %s', (url, queryTransform, expected) => {
    expect(transform(url, { queryTransform })).toBe(expected)
  })
})
