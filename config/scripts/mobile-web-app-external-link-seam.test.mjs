import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  externalLinkOffenders,
  reachesReactNativeLinking,
  reactNativeLinkingSites
} from './mobile-web-app-external-link-seam.mjs'

const mobileDir = fileURLToPath(new URL('../../mobile/', import.meta.url))

describe('the seam predicate', () => {
  it.each([
    ["import { Linking } from 'react-native'", true],
    ['import { Linking } from "react-native"', true],
    ["import * as RN from 'react-native'\nRN.Linking.openURL(u)", true],
    ['import * as RN from "react-native"\nRN.Linking.openURL(u)', true],
    ["import { View } from 'react-native'", false],
    ['import { View } from "react-native"', false]
  ])('reads %s as %s', (source, expected) => {
    expect(reachesReactNativeLinking(source)).toBe(expected)
  })
})

describe('where the seam predicate says a module reaches Linking', () => {
  it('reports the import line, which is what a red census is read for', () => {
    expect(
      reactNativeLinkingSites(
        "import { View } from 'react-native'\n\nimport {\n  Linking\n} from 'react-native'\n"
      )
    ).toEqual([3])
  })

  it('reports every line a namespace import is used on, not just the import', () => {
    expect(
      reactNativeLinkingSites(
        "import * as RN from 'react-native'\nRN.Linking.openURL(a)\nconst b = 1\nRN.Linking.openURL(c)\n"
      )
    ).toEqual([2, 4])
  })

  it('inspects every alias, not just the first namespace import', () => {
    // Two namespace imports of react-native, the first unused. Reading only the first alias makes
    // a module that calls `Linking.openURL` on the second report no site at all.
    expect(
      reactNativeLinkingSites(
        "import * as Unused from 'react-native'\nimport * as RN from 'react-native'\nRN.Linking.openURL(u)\n"
      )
    ).toEqual([3])
  })

  it('counts a line once when two aliases meet on it', () => {
    expect(
      reactNativeLinkingSites(
        "import * as A from 'react-native'\nimport * as B from 'react-native'\nA.Linking.openURL(B.Linking)\n"
      )
    ).toEqual([3])
  })

  it('finds nothing in a module that only names the seam', () => {
    expect(
      reactNativeLinkingSites("import { openExternalLink } from '../platform/external-link'")
    ).toEqual([])
  })
})

describe('the offenders in a closure', () => {
  // The seam itself imports `Linking` and is the one module allowed to, so a walk that did not
  // exempt it would report every closure as an offender and never be able to go green.
  const closure = { local: ['src/platform/external-link.web.ts', 'src/platform/external-link.ts'] }

  it('exempts the seam and names the module that went around it', () => {
    expect(externalLinkOffenders(mobileDir, closure)).toEqual(['src/platform/external-link.ts:1'])
  })

  it('ignores a path this checkout cannot read rather than calling it an offender', () => {
    expect(externalLinkOffenders(mobileDir, { local: ['src/not/a/file.ts'] })).toEqual([])
  })
})

describe('the order a red list is read in', () => {
  // Against a written fixture rather than the tree: the ordering this pins needs one module with
  // sites on lines 2 and 10, the pair that sorts one way as numbers and the other as text, and no
  // module in the closure has to keep having one.
  const root = mkdtempSync(join(tmpdir(), 'orca-seam-census-'))
  const lines = ["import * as RN from 'react-native'", 'RN.Linking.openURL(a)']
  while (lines.length < 9) {
    lines.push('')
  }
  lines.push('RN.Linking.openURL(b)')
  writeFileSync(join(root, 'wide.ts'), `${lines.join('\n')}\n`)
  writeFileSync(join(root, 'above.ts'), "import { Linking } from 'react-native'\n")

  it('puts line 2 before line 10, which sorting the rendered strings does not', () => {
    // `:10` sorts before `:2` as text. The namespace import on line 1 is not itself an offence.
    expect(externalLinkOffenders(root, { local: ['wide.ts'] })).toEqual(['wide.ts:2', 'wide.ts:10'])
  })

  it('orders by path first, so two modules never interleave', () => {
    expect(externalLinkOffenders(root, { local: ['wide.ts', 'above.ts'] })).toEqual([
      'above.ts:1',
      'wide.ts:2',
      'wide.ts:10'
    ])
  })
})
