import { expect, it, vi } from 'vitest'
import { currentAcpLaunchAccount } from './acp-structured-launch-preparation'
import type { AcpPreparedAccount } from './acp-launch-contract'

// agy's saved accounts share one login: a launch prepared it for `a`, and `b` was selected before
// the spawn.
function launch(selected: () => string, prepared: AcpPreparedAccount) {
  const prepare = vi.fn(async () => ({ key: selected(), target: selected() }))
  const spawning = {
    spec: { launchAccount: { current: selected }, account: { prepare } },
    env: {},
    preparedAccount: prepared
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: reads only these fields
  return { prepare, spawning: spawning as unknown as Parameters<typeof currentAcpLaunchAccount>[0] }
}

it('prepares the login once more when the selection moved after preparation, so the chat starts on it', async () => {
  let selected = 'a'
  const { prepare, spawning } = launch(() => selected, { key: 'a', target: 'a' })
  selected = 'b'
  expect((await currentAcpLaunchAccount(spawning, () => {})).preparedAccount).toEqual({
    key: 'b',
    target: 'b'
  })
  expect(prepare).toHaveBeenCalledOnce()
})

it('keeps what preparation found while the selection holds still, even an account it could not move', async () => {
  const failed = { key: 'a', target: 'b', failure: 'keychain access' }
  const { prepare, spawning } = launch(() => 'b', failed)
  expect((await currentAcpLaunchAccount(spawning, () => {})).preparedAccount).toBe(failed)
  expect(prepare).not.toHaveBeenCalled()
})
