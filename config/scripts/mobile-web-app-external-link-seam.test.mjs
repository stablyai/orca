import { describe, expect, it } from 'vitest'
import { reachesReactNativeLinking } from './mobile-web-app-external-link-seam.mjs'
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
