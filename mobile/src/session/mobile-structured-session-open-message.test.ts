import { afterEach, expect, it } from 'vitest'
import {
  activateMobileUiLocale,
  mobileI18n,
  setMobilePseudoLocalization
} from '../i18n/mobile-i18n'
import { pseudoLocalizeString } from '../../../src/shared/pseudo-localization'
import { mobileStructuredSessionOpenMessage } from './mobile-structured-session-open-message'

const defaults = [
  ['gone', "Agent's chat is no longer on this host, so it cannot be reopened here."],
  [
    'unknown',
    "Agent's chat could not be found on this host. Reconnect to its computer and try again."
  ],
  ['unsupported', "Agent's chat can't be reopened until Orca is updated."],
  ['unreachable', "Agent's chat is not available yet. Retry in a moment."]
] as const

afterEach(async () => {
  setMobilePseudoLocalization(false)
  mobileI18n.removeResourceBundle('fr', 'translation')
  await activateMobileUiLocale('en')
})

it.each(defaults)(
  'translates the complete named and generic %s sentences at call time',
  async (reason, generic) => {
    mobileI18n.addResourceBundle('fr', 'translation', { translationProbe: 'Autre texte' })
    await activateMobileUiLocale('fr')
    for (const label of [undefined, '', 'unknown']) {
      expect(mobileStructuredSessionOpenMessage(reason, label)).toBe(generic)
    }
    for (const [label, agent] of [
      ['claude', 'Claude'],
      ['codex', 'Codex'],
      ['Worker custom', 'Worker custom']
    ] as const) {
      expect(mobileStructuredSessionOpenMessage(reason, label)).toBe(
        generic.replace('Agent', agent)
      )
    }
    const named = `session.structuredOpen.${reason}`
    const unnamed = `${named}Generic`
    mobileI18n.addResourceBundle('fr', 'translation', {
      [named]: 'Conversation de {{agent}} : réessayez.',
      [unnamed]: 'Conversation de l’agent : réessayez.'
    })
    await activateMobileUiLocale('fr')
    expect(mobileStructuredSessionOpenMessage(reason, 'codex')).toBe(
      'Conversation de Codex : réessayez.'
    )
    expect(mobileStructuredSessionOpenMessage(reason, 'unknown')).toBe(
      'Conversation de l’agent : réessayez.'
    )
    setMobilePseudoLocalization(true)
    expect(mobileStructuredSessionOpenMessage(reason, 'Worker custom')).toBe(
      pseudoLocalizeString('Conversation de Worker custom : réessayez.', { expand: true })
    )
    expect(mobileStructuredSessionOpenMessage(reason)).toBe(
      pseudoLocalizeString('Conversation de l’agent : réessayez.', { expand: true })
    )
  }
)

it('translates proven terminal loss without changing ordinary gone-chat feedback', async () => {
  expect(mobileStructuredSessionOpenMessage('gone', 'codex', 'terminal')).toBe(
    "Agent's pane is no longer available."
  )
  mobileI18n.addResourceBundle('fr', 'translation', {
    'session.structuredOpen.paneUnavailable': 'Le panneau de l’agent n’est plus disponible.'
  })
  await activateMobileUiLocale('fr')
  expect(mobileStructuredSessionOpenMessage('gone', 'Worker custom', 'terminal')).toBe(
    'Le panneau de l’agent n’est plus disponible.'
  )
  expect(mobileStructuredSessionOpenMessage('gone', 'codex')).toBe(
    "Codex's chat is no longer on this host, so it cannot be reopened here."
  )
  setMobilePseudoLocalization(true)
  expect(mobileStructuredSessionOpenMessage('gone', undefined, 'terminal')).toBe(
    pseudoLocalizeString('Le panneau de l’agent n’est plus disponible.', { expand: true })
  )
})
