import { describe, expect, it } from 'vitest'
import {
  MOBILE_WEB_RNW_BUILD_BUDGET,
  mobileWebRnwBuildBudgetFailures
} from './mobile-web-rnw-build-budget.mjs'

describe('RNW mobile web build budget', () => {
  it('accepts every measurement at its reviewed ceiling', () => {
    expect(mobileWebRnwBuildBudgetFailures(MOBILE_WEB_RNW_BUILD_BUDGET)).toEqual([])
  })

  it.each(Object.keys(MOBILE_WEB_RNW_BUILD_BUDGET))('rejects %s above its ceiling', (key) => {
    expect(
      mobileWebRnwBuildBudgetFailures({
        ...MOBILE_WEB_RNW_BUILD_BUDGET,
        [key]: MOBILE_WEB_RNW_BUILD_BUDGET[key] + 1
      })
    ).toEqual([key])
  })
})
