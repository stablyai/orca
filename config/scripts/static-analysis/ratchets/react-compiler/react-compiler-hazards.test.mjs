import { describe, expect, it } from 'vitest'

import {
  findMemoizedHookCalls,
  findMemoizedStoreReads,
  findSourceHazards,
  renderStoreReadLines
} from './react-compiler-hazards.mjs'

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

  it('flags a useSyncExternalStore result that is thrown away, not one that is kept', () => {
    const src = [
      'export function useRows(id) {',
      '  useSyncExternalStore(subscribe, getSnapshot)',
      '  const version = useSyncExternalStore(subscribe, getSnapshot)',
      '  return read(id, version)',
      '}'
    ].join('\n')
    expect(
      findSourceHazards('a.ts', src).map(({ kind, fn, line }) => `${fn}:${kind}:${line}`)
    ).toEqual(['useRows:discarded-subscription:2'])
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

describe('store reads in memo blocks', () => {
  it('finds getState() in a guarded block but not in a closure, and skips source useMemo reads', () => {
    const compiled = [
      'import { c as _c } from "react/compiler-runtime";',
      'export function useRoute(n) {',
      '  const $ = _c(2);',
      '  let t0;',
      '  if ($[0] !== n) {',
      '    t0 = { r: route(store.getState(), n), f: () => store.getState() };',
      '    $[0] = n;',
      '    $[1] = t0;',
      '  } else {',
      '    t0 = $[1];',
      '  }',
      '  return t0;',
      '}'
    ].join('\n')
    expect(findMemoizedStoreReads('a.js', compiled)).toEqual([{ fn: 'useRoute' }])
    const src = [
      'export function useRoute(n) {',
      '  const paused = useMemo(() => store.getState(), [n])',
      '  return { r: route(store.getState(), n), paused }',
      '}'
    ].join('\n')
    expect(renderStoreReadLines('a.ts', src, 'useRoute')).toEqual([3])
  })
})
