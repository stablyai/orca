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
