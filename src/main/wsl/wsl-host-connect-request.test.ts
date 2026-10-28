import { expect, it } from 'vitest'
import { wslHostConnectOptions } from './wsl-host-connect-request'

it("keeps the Settings Connect's withdrawal of a pending Remove", () => {
  expect(wslHostConnectOptions({})).toEqual({ withdrawPendingRemoval: true })
  expect(wslHostConnectOptions({ intent: 'force' })).toEqual({
    withdrawPendingRemoval: true,
    intent: 'force'
  })
})

it("lets a chat's Start refuse a pending Remove instead of cancelling it", () => {
  expect(wslHostConnectOptions({ withdrawPendingRemoval: false })).toEqual({
    withdrawPendingRemoval: false
  })
})

it('ignores intents and flags it does not know', () => {
  expect(wslHostConnectOptions({ intent: 'boot', withdrawPendingRemoval: 'no' })).toEqual({
    withdrawPendingRemoval: true
  })
})
