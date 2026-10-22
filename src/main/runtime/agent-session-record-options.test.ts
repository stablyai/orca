import { expect, it } from 'vitest'
import { seedOptionsAdmittedOnSavedListing } from './agent-session-record-options'

const row = (id: string, efforts: readonly string[]) => ({
  id,
  label: id,
  isDefault: false,
  efforts: efforts.map((value) => ({ value, label: value }))
})

it('drops a remembered value its model row no longer admits', () => {
  expect(
    seedOptionsAdmittedOnSavedListing(
      'pi',
      { model: 'some/model', effort: 'off' },
      [row('some/model', [])],
      new Set()
    )
  ).toEqual({ model: 'some/model' })
})

it('keeps remembered values its model row admits', () => {
  expect(
    seedOptionsAdmittedOnSavedListing(
      'pi',
      { model: 'some/model', effort: 'low' },
      [row('some/model', ['low', 'high'])],
      new Set()
    )
  ).toEqual({ model: 'some/model', effort: 'low' })
})

it('keeps a value this launch named itself, even one its row does not admit', () => {
  expect(
    seedOptionsAdmittedOnSavedListing(
      'pi',
      { model: 'some/model', effort: 'off' },
      [row('some/model', ['low'])],
      new Set(['effort'])
    )
  ).toEqual({ model: 'some/model', effort: 'off' })
})

it('admits every remembered value of a model the listing does not name', () => {
  expect(
    seedOptionsAdmittedOnSavedListing(
      'pi',
      { model: 'unlisted/model', effort: 'off' },
      [row('other/model', ['low'])],
      new Set()
    )
  ).toEqual({ model: 'unlisted/model', effort: 'off' })
})

it('admits every remembered value when no rows are saved', () => {
  expect(
    seedOptionsAdmittedOnSavedListing(
      'pi',
      { model: 'some/model', effort: 'off' },
      undefined,
      new Set()
    )
  ).toEqual({ model: 'some/model', effort: 'off' })
})
