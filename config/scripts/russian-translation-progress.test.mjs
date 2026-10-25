import { expect, it } from 'vitest'
import { russianTranslationProgress } from './russian-translation-progress.mjs'

it('distinguishes untranslated UI from original product names and executable commands', () => {
  const source = {
    provider: 'Codex',
    command: 'pnpm install',
    website: 'https://example.com',
    button: 'Continue',
    status: 'idle',
    missing: 'Project'
  }
  const { missing: _missing, ...russian } = source
  const progress = russianTranslationProgress(source, russian)
  expect(progress.translated).toBe(0)
  expect(progress.missing).toEqual(['missing'])
  expect(progress.unreviewedCopies).toEqual(['button', 'status'])
  expect(Object.keys(progress.domains['navigation-workspace-runtime'].ru)).toEqual([
    'button',
    'status',
    'missing'
  ])
})

it('binds reviewed technical exceptions to their exact English source', () => {
  const original = { auto: { components: { TaskPage: { '3659f9792a': 'board' } } } }
  expect(russianTranslationProgress(original, original).unreviewedCopies).toEqual([])
  const changed = { auto: { components: { TaskPage: { '3659f9792a': 'Continue' } } } }
  expect(russianTranslationProgress(changed, changed).unreviewedCopies).toEqual([
    'auto.components.TaskPage.3659f9792a'
  ])
})
