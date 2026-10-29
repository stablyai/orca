import { expect, it, vi } from 'vitest'
import {
  committedMobileSessionTabClose,
  delegatedMobileSessionTabClose,
  refusedMobileSessionTabClose
} from './mobile-session-tab-close-outcome'

it('serializes a retirement receipt only after committed host selection retirement', () => {
  const forgetTabs = vi.fn()
  const committed = committedMobileSessionTabClose({ forgetTabs }, 'workspace', ['tab'])
  expect(forgetTabs).toHaveBeenCalledExactlyOnceWith('workspace', ['tab'])
  expect(JSON.parse(JSON.stringify(committed))).toEqual({ closed: true, retirementConfirmed: true })
  expect(JSON.parse(JSON.stringify(delegatedMobileSessionTabClose()))).toEqual({ closed: true })
  expect(JSON.parse(JSON.stringify(refusedMobileSessionTabClose('unknown-liveness')))).toEqual({
    closed: true,
    refused: true,
    refusalReason: 'unknown-liveness'
  })
})

it('cannot acknowledge retirement when selection retirement throws', () => {
  const forgetTabs = vi.fn(() => {
    throw new Error('not committed')
  })
  expect(() => committedMobileSessionTabClose({ forgetTabs }, 'workspace', ['tab'])).toThrow(
    'not committed'
  )
})
