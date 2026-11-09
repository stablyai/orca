import { afterEach, expect, it } from 'vitest'
import { agentSessionFailureSentence } from '../../../src/shared/agent-session/failures/agent-session-failure-words'
import { activateMobileUiLocale } from '../i18n/mobile-i18n'
import { sayMobileAgentSessionFailure } from './agent-session-failure-copy'

afterEach(async () => {
  await activateMobileUiLocale('en')
})

it('gives new-chat guidance while keeping a missing conversation diagnostic private', () => {
  expect(
    agentSessionFailureSentence(
      {
        kind: 'savedConversationMissing',
        detail: { text: 'No conversation found with session ID: private-id', audience: 'log' }
      },
      'row',
      { agentName: 'Claude' },
      sayMobileAgentSessionFailure
    )
  ).toBe("Claude couldn't find this chat's saved conversation. Start a new chat to continue.")
})

it.each([
  [
    'en',
    'OMP has no model selected. Check your model selection and OMP sign-in, then send again.',
    "OMP couldn't use @worker_be. Update OMP to 18.1.9 or later to keep it after a restart, or pick another model and send again."
  ],
  [
    'de',
    'OMP hat kein Modell ausgewählt. Modellauswahl und OMP-Anmeldung prüfen und erneut senden.',
    expect.stringContaining('OMP auf 18.1.9 oder neuer aktualisieren')
  ]
] as const)(
  'words a missing OMP model and the update hint on the phone (%s)',
  async (locale, none, update) => {
    await activateMobileUiLocale(locale)
    const say = (fact: Parameters<typeof agentSessionFailureSentence>[0]) =>
      agentSessionFailureSentence(
        fact,
        'rejection',
        { agentName: 'OMP' },
        sayMobileAgentSessionFailure
      )
    expect(say({ kind: 'modelNotSelected' })).toBe(none)
    expect(
      say({
        kind: 'modelUnavailable',
        detail: { text: '@worker_be', audience: 'log' },
        agentUpdate: '18.1.9'
      })
    ).toEqual(update)
  }
)
