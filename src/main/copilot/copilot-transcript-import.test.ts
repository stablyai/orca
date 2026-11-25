import { expect, it } from 'vitest'
import { COPILOT_TRANSCRIPT_IMPORT } from './copilot-transcript-import'

it('finds a Copilot session under the account’s session-state directory', async () => {
  expect(
    await COPILOT_TRANSCRIPT_IMPORT.findTranscript({
      providerSessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      store: '/home/me/.copilot/session-state',
      launchEnv: {},
      workspaceCwd: '/repo'
    })
  ).toBe('/home/me/.copilot/session-state/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/events.jsonl')
})

it('never lets a session id leave the store', async () => {
  for (const providerSessionId of ['../other', 'a/b', '', '/etc/passwd']) {
    expect(
      await COPILOT_TRANSCRIPT_IMPORT.findTranscript({
        providerSessionId,
        store: '/home/me/.copilot/session-state',
        launchEnv: {},
        workspaceCwd: '/repo'
      })
    ).toBeNull()
  }
})
