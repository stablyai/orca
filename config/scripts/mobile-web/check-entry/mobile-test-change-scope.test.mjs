import { expect, it } from 'vitest'
import { shouldRunMobileTests } from './mobile-test-change-scope.mjs'

it('retains tests on missing evidence and a move out of the source tree', () => {
  expect(shouldRunMobileTests([])).toBe(true)
  expect(shouldRunMobileTests(['mobile/src/deleted.ts', 'mobile/docs/moved.ts'])).toBe(true)
})

it('retains unknown suite paths and noncanonical traversal evidence', () => {
  expect(shouldRunMobileTests(['unknown/module.test.ts'])).toBe(true)
  expect(shouldRunMobileTests(['src/unknown/module.test.ts'])).toBe(true)
  expect(shouldRunMobileTests(['src/shared/../main/module.test.ts'])).toBe(true)
})
