// The page gate keeps old phones loading: a missed feature reaches them only as a blank session.
import { describe, expect, it } from 'vitest'
import { findFeaturesPastIosMinimum } from './mobile-web-ios-minimum.mjs'

const CHUNK = [
  'const comment=/(?<=^|\\s)#.*/u;',
  'const heredoc=new RegExp(`(${x})|(?<!<)<<(\\w+)`,"gmu");',
  'const fd="(?:(?<=^|\\\\s)\\\\d+)?";',
  'const sets=/[\\p{L}--[a-z]]/v;',
  'const twice=/(?<y>\\d{4})-\\d|\\d-(?<y>\\d{4})/;',
  'export function room(e){return Map.groupBy(e,(a)=>a.root)}',
  'export function exact(v){return new RegExp(`^${RegExp.escape(v)}$`,"u")}',
  'export function load(r){try{return Object.groupBy(r,(a)=>a.k)}catch(e){throw e}}',
  'export function valid(u){return URL.canParse(u)}',
  'let probe;try{probe=new RegExp("(?<=1)(?<!1)")}catch{probe=null}',
  'export const clone=typeof structuredClone==="function"&&structuredClone({});',
  'export const grouped=typeof Map.groupBy!=="function"?fallback():Map.groupBy([],(a)=>a);',
  'export const parsed=URL.parse?.("x")??null;'
].join('\n')

const features = (minimum) =>
  findFeaturesPastIosMinimum(CHUNK, 'chunk.js', minimum).map(({ feature, text }) => [feature, text])

describe('findFeaturesPastIosMinimum', () => {
  it('finds regex features in literals and RegExp strings, and untested statics, past the minimum', () => {
    expect(features('16.0')).toEqual([
      ['regex lookbehind', '/(?<=^|\\s)#.*/u'],
      ['regex lookbehind', 'new RegExp(`(${x})|(?<!<)<<(\\w+)`,"gmu")'],
      ['regex lookbehind', '"(?:(?<=^|\\\\s)\\\\d+)?"'],
      ['regex v flag', '/[\\p{L}--[a-z]]/v'],
      ['regex duplicate named groups', '/(?<y>\\d{4})-\\d|\\d-(?<y>\\d{4})/'],
      ['Map.groupBy', 'Map.groupBy(e,(a)=>a.root)'],
      ['RegExp.escape', 'RegExp.escape(v)'],
      ['Object.groupBy', 'Object.groupBy(r,(a)=>a.k)'],
      ['URL.canParse', 'URL.canParse(u)']
    ])
    expect(features('16.4').map(([feature]) => feature)).toEqual([
      'regex v flag',
      'regex duplicate named groups',
      'Map.groupBy',
      'RegExp.escape',
      'Object.groupBy',
      'URL.canParse'
    ])
    expect(features('18.2')).toEqual([])
  })
})
