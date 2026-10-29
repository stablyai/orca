import { expect, it } from 'vitest'
import { sessionTabClose } from './mobile-session-write-operations'

it.each([
  [{}, false, false],
  [{ closed: true }, false, false],
  [{ closed: true, retirementConfirmed: true }, false, true],
  [{ closed: true, retirementConfirmed: false }, false, false],
  [{ closed: true, retirementConfirmed: 'true' }, false, false],
  [{ closed: false, retirementConfirmed: true }, false, false],
  [{ closed: 'true', retirementConfirmed: true }, false, false],
  [{ closed: true, retirementConfirmed: true, refused: true }, true, false],
  [{ closed: true, retirementConfirmed: true, refused: false }, false, true],
  [{ closed: true, retirementConfirmed: true, refused: 'true' }, false, false],
  [null, false, false],
  ['closed', false, false]
] as const)(
  'reads close authority conservatively from %j',
  (result, refused, retirementConfirmed) => {
    expect(sessionTabClose.interpret({ id: 'close', ok: true, result })).toEqual({
      accepted: true,
      value: { refused, retirementConfirmed }
    })
  }
)

it('keeps outer refusal separate from a claimed retirement receipt', () => {
  expect(
    sessionTabClose.interpret({
      id: 'close',
      ok: false,
      error: { code: 'refused', message: 'live' }
    })
  ).toEqual({ accepted: false })
})
