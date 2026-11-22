import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

function dependencyRequire(packages) {
  let require = createRequire(import.meta.url)
  for (const name of packages) {
    require = createRequire(require.resolve(name))
  }
  return require
}

// Resolve through declared consumers so hoisting cannot select another workspace's copy.
const sprintfRequire = dependencyRequire([
  'electron-builder',
  'app-builder-lib',
  '@electron/get',
  'global-agent',
  'roarr'
])
const picomatchRequire = dependencyRequire(['@parcel/watcher'])

describe('installed dependency security patches', () => {
  it.each(['src/sprintf.js', 'dist/sprintf.min.js'])('bounds numeric precision in %s', (entry) => {
    const { sprintf } = sprintfRequire(`sprintf-js/${entry}`)
    for (const type of ['e', 'f', 'g']) {
      expect(() => sprintf(`%.${'9'.repeat(500)}${type}`, 1.234)).not.toThrow()
      expect(sprintf(`%.${'9'.repeat(500)}${type}`, 1.234).length).toBeLessThan(110)
    }
  })

  it('collapses repeated wildcard extglobs in picomatch without nested quantifiers', () => {
    const picomatch = picomatchRequire('picomatch')
    expect(picomatch('+(*a)')('aaa')).toBe(true)
    expect(picomatch('+(*a)')(`${'a'.repeat(40)}b`)).toBe(false)
    expect(picomatch('+(*a)', { capture: true })('+(*a)')).toBe(true)
  })
})
