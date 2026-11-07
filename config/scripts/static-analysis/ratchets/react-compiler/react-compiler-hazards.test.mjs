import { describe, expect, it } from 'vitest'

import { findMemoizedHookCalls, findSourceHazards } from './react-compiler-hazards.mjs'

describe('findSourceHazards', () => {
  it('flags bare reads, postfix member values and opt-outs only inside components and hooks', () => {
    const src = [
      'export function useQueue(q, tick) {',
      '  void tick',
      '  void el?.offsetWidth',
      '  void save()',
      '  const next = q.items[q.head++]',
      '  q.head++',
      '  let i = 0',
      '  const v = q.items[i++]',
      '}',
      'export const Row = memo(() => {',
      "  'use no memo'",
      '  return null',
      '})',
      'function flush(el) {',
      '  void el.offsetWidth',
      '  return q.items[q.head++]',
      '}'
    ].join('\n')
    expect(
      findSourceHazards('a.tsx', src).map(({ kind, fn, line }) => `${fn}:${kind}:${line}`)
    ).toEqual([
      'useQueue:void-read:2',
      'useQueue:void-read:3',
      'useQueue:member-postfix-value:5',
      'Row:opt-out-directive:11'
    ])
  })
})

describe('findMemoizedHookCalls', () => {
  it('finds hooks inside cache-guarded blocks, not hoisted ones or ones in closures', () => {
    const compiled = [
      'import { c as _c } from "react/compiler-runtime";',
      'export function useThing(n) {',
      '  const $ = _c(2);',
      '  const s = useState(n);',
      '  let t0;',
      '  if ($[0] !== n) {',
      '    t0 = { n, s, r: useRef(n), f: () => useNever() };',
      '    $[0] = n;',
      '    $[1] = t0;',
      '  } else {',
      '    t0 = $[1];',
      '  }',
      '  return t0;',
      '}'
    ].join('\n')
    expect(findMemoizedHookCalls('a.js', compiled)).toEqual([{ fn: 'useThing', hook: 'useRef' }])
  })
})
