import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { activateMobileUiLocale, mobileI18n } from '../i18n/mobile-i18n'
import { textGenerationErrorText } from './text-generation-failure-copy'

beforeEach(async () => {
  mobileI18n.addResourceBundle('de', 'translation', {
    'sourceControl.textGenerationFailure.cliFailedWithDetail':
      '{{label}} fehlgeschlagen ({{exitCode}}): {{detail}}',
    'sourceControl.textGenerationFailure.noStagedChanges': 'Keine Änderungen vorgemerkt.',
    'sourceControl.textGenerationFailure.planModelUnavailable':
      'Modell {{model}} für {{label}} nicht verfügbar.',
    'sourceControl.textGenerationFailure.kimiConflictingOptions':
      'Kimi: {{option}} und {{otherOption}} widersprechen sich.'
  })
  await activateMobileUiLocale('de')
})

afterEach(async () => {
  await activateMobileUiLocale('en')
  mobileI18n.removeResourceBundle('de', 'translation')
})

describe('textGenerationErrorText', () => {
  it('translates coded failures and preserves agent output verbatim', () => {
    expect(
      textGenerationErrorText({
        error: 'host error',
        errorCode: 'cliFailedWithDetail',
        errorParams: { label: 'Codex', exitCode: 0, detail: 'ignored' },
        errorDetail: '{{label}}: $t(secret) <stderr>'
      })
    ).toBe('Codex fehlgeschlagen (0): {{label}}: $t(secret) <stderr>')
    expect(textGenerationErrorText({ error: 'host error', errorCode: 'noStagedChanges' })).toBe(
      'Keine Änderungen vorgemerkt.'
    )
  })

  it.each([
    {},
    { errorCode: 'newerHostCode' },
    { errorCode: 'toString' },
    { errorCode: 42 },
    { errorCode: 'cliFailedWithDetail', errorParams: { label: 'Codex', exitCode: 1 } },
    {
      errorCode: 'cliFailedWithDetail',
      errorParams: { label: 'Codex', exitCode: null },
      errorDetail: 'detail'
    },
    {
      errorCode: 'cliFailedWithDetail',
      errorParams: { label: 'Codex', exitCode: 1, detail: 'not errorDetail' }
    },
    { errorCode: 'agentCouldNotStart', errorParams: 'Codex' }
  ])('keeps the host error when the code or required values are unavailable: %j', (fields) => {
    expect(textGenerationErrorText({ error: 'Host English', ...fields })).toBe('Host English')
  })
})
