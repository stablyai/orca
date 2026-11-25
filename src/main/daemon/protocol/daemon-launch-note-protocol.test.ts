import { expect, it } from 'vitest'
import { parseDaemonLaunchNoteChange } from './daemon-launch-note-protocol'

it('keeps the recorded Claude account across a main restart', () => {
  const armed = (claudeAccountId: unknown): unknown =>
    parseDaemonLaunchNoteChange({
      arm: { launchToken: 't-1', launchConfig: { agentArgs: '', agentEnv: {}, claudeAccountId } }
    })
  const note = (extra: { claudeAccountId?: string }): unknown => ({
    arm: { launchToken: 't-1', launchConfig: { agentArgs: '', agentEnv: {}, ...extra } }
  })

  expect(armed('acct-b')).toEqual(note({ claudeAccountId: 'acct-b' }))
  expect(armed('__active__')).toEqual(note({ claudeAccountId: '__active__' }))
  expect(armed(42)).toEqual(note({}))
})
