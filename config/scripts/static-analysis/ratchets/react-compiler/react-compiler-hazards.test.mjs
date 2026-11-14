import { describe, expect, it } from 'vitest'

import {
  findLiveReadWrappers,
  findMemoizedCalls,
  findMemoizedHookCalls,
  findMemoizedStoreReads,
  findSourceHazards,
  findVirtualizerMemoFlows,
  findVirtualizerWrappers,
  renderLiveReadLines,
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

describe('virtualizer flows into memo blocks', () => {
  it('follows wrapper hooks and flags cached reads and props, not closures or bound methods', () => {
    const wrapper = [
      'export function useRows(n) {',
      '  const virtualizer = useVirtualizer({ count: n })',
      '  return { virtualizer, n }',
      '}'
    ].join('\n')
    expect(findVirtualizerWrappers('w.ts', wrapper)).toEqual([
      { name: 'useRows', shape: 'property' }
    ])
    const hooks = new Map([
      ['useVirtualizer', 'direct'],
      ['useList', 'direct']
    ])
    const compiled = [
      'import { c as _c } from "react/compiler-runtime";',
      'export function Pane() {',
      '  const $ = _c(4);',
      '  const list = useList();',
      '  let t0;',
      '  if ($[0] !== list) {',
      '    t0 = <Rows list={list} height={list.getTotalSize()} onPick={() => list.scrollToIndex(0)} rowRef={list.measureElement} />;',
      '    $[0] = list;',
      '    $[1] = t0;',
      '  } else {',
      '    t0 = $[1];',
      '  }',
      '  let t1;',
      '  if ($[2] !== list) {',
      '    t1 = () => list.getVirtualItems();',
      '    $[2] = list;',
      '    $[3] = t1;',
      '  } else {',
      '    t1 = $[3];',
      '  }',
      '  return t0;',
      '}'
    ].join('\n')
    expect(
      findVirtualizerMemoFlows('a.jsx', '', compiled, hooks).map(({ fn, text }) => `${fn}:${text}`)
    ).toEqual(['Pane:list={list}', 'Pane:list.getTotalSize'])
  })
})

describe('live module-state reads in memo blocks', () => {
  it('follows plain wrappers and flags a render read the compiler caches, not a useMemo one', () => {
    const lib = [
      'export function scopeKey(s) {',
      '  return s ? runtimeKey(s.env) : null',
      '}',
      'export const later = (s) => () => runtimeKey(s)',
      'export function useScope(s) {',
      '  return runtimeKey(s)',
      '}'
    ].join('\n')
    expect(findLiveReadWrappers('lib.ts', lib, new Set(['runtimeKey']))).toEqual(['scopeKey'])
    const compiled = [
      'import { c as _c } from "react/compiler-runtime";',
      'export function Card(t0) {',
      '  const $ = _c(2);',
      '  const { settings } = t0;',
      '  let t1;',
      '  if ($[0] !== settings) {',
      '    t1 = scopeKey(settings);',
      '    $[0] = settings;',
      '    $[1] = t1;',
      '  } else {',
      '    t1 = $[1];',
      '  }',
      '  return t1;',
      '}'
    ].join('\n')
    const readers = new Set(['runtimeKey', 'scopeKey'])
    expect(findMemoizedCalls('a.js', compiled, readers)).toEqual([
      { fn: 'Card', kind: 'live-read', name: 'scopeKey' }
    ])
    const src = [
      'export function Card({ settings }) {',
      '  const kept = useMemo(() => scopeKey(settings), [settings])',
      '  return [kept, scopeKey(settings)]',
      '}'
    ].join('\n')
    expect(renderLiveReadLines('a.tsx', src, 'Card', 'scopeKey')).toEqual([3])
  })
})
