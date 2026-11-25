import { expect, it } from 'vitest'
import { readClaudeCatalogObservation } from './claude-model-catalog-observation'

function replies(account: Record<string, unknown>) {
  return new Map<string, unknown>([
    ['orca-model-discovery', { models: [{ value: 'fixture-model', displayName: 'Fixture' }] }],
    ['orca-model-settings', { applied: { model: 'fixture-model' } }],
    ['orca-signin-discovery', { account }]
  ])
}

it.each([
  ['a configured OAuth token', { tokenSource: 'claude.ai' }],
  ['a configured API key', { apiKeySource: 'ANTHROPIC_API_KEY' }]
])('does not treat %s as a confirmed sign-in', (_case, account) => {
  const observation = readClaudeCatalogObservation(replies(account), {}, 'system')
  expect(observation.complete).toBe(true)
  expect(observation).not.toHaveProperty('signedIn')
})
