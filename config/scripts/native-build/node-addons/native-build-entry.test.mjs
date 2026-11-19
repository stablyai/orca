import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { nodePtyNativeModuleName } = require('./native-build-entry.cjs')

const DECISIONS = [
  { build: 17762, useConptyDll: false, expected: 'pty' },
  { build: 17762, useConptyDll: true, expected: 'pty' },
  { build: 17763, useConptyDll: false, expected: 'pty' },
  { build: 17763, useConptyDll: true, expected: 'conpty' },
  { build: 18308, useConptyDll: false, expected: 'pty' },
  { build: 18308, useConptyDll: true, expected: 'conpty' },
  { build: 18309, useConptyDll: false, expected: 'conpty' },
  { build: 18309, useConptyDll: true, expected: 'conpty' }
]

describe('nodePtyNativeModuleName Windows backend gate', () => {
  for (const { build, useConptyDll, expected } of DECISIONS) {
    it(`build ${build}, useConptyDll=${useConptyDll} -> ${expected}`, () => {
      expect(nodePtyNativeModuleName('win32', `10.0.${build}`, useConptyDll)).toBe(expected)
    })
  }

  it('defaults to the bundled-DLL decision on Windows', () => {
    expect(nodePtyNativeModuleName('win32', '10.0.17763')).toBe('conpty')
    expect(nodePtyNativeModuleName('darwin', '10.0.17763')).toBe('pty')
  })
})
