import { expect, it } from 'vitest'
import { machineRoomSubmissionAdmitted } from './machine-harness-session'

it('waits for the provider after admission and never retries an unknown delivery automatically', () => {
  expect(machineRoomSubmissionAdmitted('pending')).toBe(true)
  expect(machineRoomSubmissionAdmitted('accepted')).toBe(true)
  expect(machineRoomSubmissionAdmitted('rejected')).toBe(false)
  expect(() => machineRoomSubmissionAdmitted('unknown')).toThrow('conversation_delivery_uncertain')
})
