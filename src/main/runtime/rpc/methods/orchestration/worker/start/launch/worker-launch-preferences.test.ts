import { expect, it } from 'vitest'
import { resolveWorkerLaunchPreferences } from './worker-launch-preferences'

it('records the requested Antigravity level id while launching its family', () => {
  expect(
    resolveWorkerLaunchPreferences({
      agent: 'antigravity',
      model: 'gemini-4-argon-medium',
      effort: 'medium'
    }).receipt
  ).toEqual({
    requested: { agent: 'antigravity', model: 'gemini-4-argon-medium', effort: 'medium' },
    effective: { agent: 'antigravity', model: 'gemini-4-argon', effort: 'medium' }
  })
})
