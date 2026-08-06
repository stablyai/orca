import { describe, expect, it } from 'vitest'

import { collectLocalizationCandidates } from './audit-localization-coverage.mjs'
import { collectMobileTranslationCalls } from './verify-mobile-localization-catalog.mjs'

const FILE_PATH = '/repo/mobile/src/components/Example.tsx'
const ROOT = '/repo'

function candidateTexts(source) {
  return collectLocalizationCandidates(FILE_PATH, source, ROOT).map((candidate) => candidate.text)
}

function translationKeys(source) {
  return collectMobileTranslationCalls(FILE_PATH, source, ROOT).map((call) => call.keys)
}

describe('mobile localization exact-head regressions', () => {
  it('resolves captured properties at their snapshot sites', () => {
    const source = `
import { t } from '@/i18n/mobile-i18n'
const raw = (value) => value
let tr = raw
const box = { nested: { tr } }
const { nested: { tr: snapshot } } = box
tr = t
export const label = <><Text>{box.nested.tr('mobileWorkspaceStatuses.todo')}</Text><Text>{snapshot('mobileWorkspaceStatuses.progress')}</Text></>
`

    expect(translationKeys(source)).toEqual([])
    expect(candidateTexts(source)).toEqual([
      'mobileWorkspaceStatuses.todo',
      'mobileWorkspaceStatuses.progress'
    ])
  })

  it('keeps property writes scoped to the current object allocation', () => {
    const source = `
import { t } from '@/i18n/mobile-i18n'
const raw = (value) => value
let source = { tr: raw }
const snapshot = source
source = { tr: raw }
source.tr = t
export const label = <Text>{snapshot.tr('mobileWorkspaceStatuses.todo')}</Text>
`

    expect(translationKeys(source)).toEqual([])
    expect(candidateTexts(source)).toEqual(['mobileWorkspaceStatuses.todo'])
  })

  it('includes same-loop writes that reach later iterations', () => {
    const source = `
export function Example({ items }) {
  const rows = []
  let label = 'First row'
  for (const item of items) {
    rows.push(<Text key={item.id}>{label}</Text>)
    label = 'Following rows'
  }
  return rows
}
`

    expect(candidateTexts(source)).toEqual(['First row', 'Following rows'])
  })

  it('finds rendered logical and member assignments', () => {
    const source = `
export function Example() {
  let label
  label ??= 'Fallback copy'
  const copy = { nested: {} }
  copy.nested.label = 'Visible property copy'
  return <><Text>{label}</Text><Text>{copy.nested.label}</Text></>
}
`

    expect(candidateTexts(source)).toEqual(['Fallback copy', 'Visible property copy'])
  })

  it('tracks array, nested, and defaulted destructuring writes', () => {
    const source = `
import { t } from '@/i18n/mobile-i18n'
const raw = (value) => value
let arrayTr = t
let nestedTr = t
let render
function fallback() { return 'Default render copy' }
[arrayTr] = [raw]
({ nested: { tr: nestedTr } } = { nested: { tr: raw } })
({ render = fallback } = {})
export const label = <><Text>{arrayTr('mobileWorkspaceStatuses.todo')}</Text><Text>{nestedTr('mobileWorkspaceStatuses.progress')}</Text><Text>{render()}</Text></>
`

    expect(translationKeys(source)).toEqual([])
    expect(candidateTexts(source)).toEqual([
      'Default render copy',
      'mobileWorkspaceStatuses.todo',
      'mobileWorkspaceStatuses.progress'
    ])
  })

  it('ignores selector constants used only in attribute comparisons', () => {
    const source = `
import { t } from '@/i18n/mobile-i18n'
export function Example({ mode }) {
  const specialMode = 'special-mode'
  return <Button title={mode === specialMode ? t('mobileWorkspaceStatuses.todo') : t('mobileWorkspaceStatuses.progress')} />
}
`

    expect(candidateTexts(source)).toEqual([])
  })

  it('preserves translator descriptors through namespace spreads', () => {
    const source = `
import * as i18n from '@/i18n/mobile-i18n'
const local = { ...i18n }
export const label = local.t('example.spread')
`

    expect(translationKeys(source)).toEqual([['example.spread']])
  })
})
