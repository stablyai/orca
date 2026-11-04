import { describe, expect, it } from 'vitest'

import { findUnsubscribedMemoComponents } from './check-memo-translate-subscription-ratchet.mjs'

describe('findUnsubscribedMemoComponents', () => {
  it('flags inline and named memo components in translating files', () => {
    const source = [
      'const Row = React.memo(function Row() {',
      "  return <span>{translate('k', 'Row')}</span>",
      '})',
      'function PickerInner(): React.JSX.Element {',
      '  return <Label />',
      '}',
      'export const Picker = memo(PickerInner)'
    ].join('\n')
    expect(findUnsubscribedMemoComponents(source)).toEqual(['Row', 'PickerInner'])
  })

  it('accepts subscribed components, imported targets and files without translate()', () => {
    expect(
      findUnsubscribedMemoComponents(
        [
          'const Row = memo(function Row() {',
          '  useUiLanguageRevision()',
          "  return translate('k', 'Row')",
          '})',
          'const Imported = memo(ImportedButton)'
        ].join('\n')
      )
    ).toEqual([])
    expect(
      findUnsubscribedMemoComponents('const Row = memo(function Row() { return null })')
    ).toEqual([])
  })
})
