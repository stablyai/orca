import { createContext, runInContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { MOBILE_WEB_MAX_ASSET_BYTES } from '../../src/shared/mobile-web/manifest-contract'
import { splitMobileWebRnwScript } from './mobile-web-rnw-script-chunks.mjs'

function execute(scripts: string[]) {
  const context = createContext({})
  for (const script of scripts) {
    runInContext(script, context)
  }
  return JSON.parse(JSON.stringify(context.result))
}

const prelude = `var modules={},result=[];function __d(fn,id){modules[id]=fn}function __r(id){modules[id]()};`

describe('RNW script chunks', () => {
  it('preserves Metro module registration, startup order and literal boundary lookalikes', () => {
    const source = `${
      prelude +
      Array.from(
        { length: 10 },
        (_, index) => `__d(function(){result.push([${index},'😀;__d(function(){})'])},${index});\n`
      ).join('')
    }__r(9);__r(0);`
    const chunks = splitMobileWebRnwScript(source, 250)
    expect(chunks.length).toBeGreaterThan(2)
    expect(chunks.every((chunk: string) => Buffer.byteLength(chunk) <= 250)).toBe(true)
    expect(execute(chunks)).toEqual(execute([source]))
    expect(execute(chunks)).toEqual([
      [9, '😀;__d(function(){})'],
      [0, '😀;__d(function(){})']
    ])
  })

  it('preserves directive semantics on every split', () => {
    const source = `"use strict";${prelude}${Array.from(
      { length: 6 },
      (_, index) =>
        `__d(function(){result.push((function(){return this===undefined})())},${index});`
    ).join('')}__r(5);`
    const chunks = splitMobileWebRnwScript(source, 220)
    expect(chunks.every((chunk: string) => chunk.startsWith('"use strict";'))).toBe(true)
    expect(execute(chunks)).toEqual([true])
  })

  it('refuses unsafe ordering, parse errors and indivisible oversized modules', () => {
    expect(() =>
      splitMobileWebRnwScript(`${prelude}__d(function(){},0);` + `var later=1;`, 100)
    ).toThrow('ordering')
    expect(() =>
      splitMobileWebRnwScript(
        `${prelude}__r(0);__d(function(){},0);__r(0);__d(function(){},1);`,
        100
      )
    ).toThrow('ordering')
    expect(() => splitMobileWebRnwScript(`${prelude}__d(function(){`, 100)).toThrow('invalid')
    expect(() =>
      splitMobileWebRnwScript(
        `${prelude}__d(function(){return '${'x'.repeat(MOBILE_WEB_MAX_ASSET_BYTES)}'},0);`,
        200
      )
    ).toThrow('module exceeds')
  })

  it('retains small cached-compatible single scripts without rewriting', () => {
    expect(splitMobileWebRnwScript('globalThis.ready=true')).toEqual(['globalThis.ready=true'])
  })
})

it('keeps a module above the chunk target intact within the native asset ceiling', () => {
  const source = `${prelude}__d(function(){result.push('${'x'.repeat(250)}')},0);__r(0);`
  const chunks = splitMobileWebRnwScript(source, 200)
  expect(chunks.some((chunk: string) => Buffer.byteLength(chunk) > 200)).toBe(true)
  expect(execute(chunks)).toEqual(execute([source]))
})
