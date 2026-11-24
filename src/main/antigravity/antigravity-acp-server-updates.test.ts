import { expect, it } from 'vitest'
import { ANTIGRAVITY_LAUNCH_SPEC } from './antigravity-acp-launch-spec'
import { ANTIGRAVITY_ACP_RUNTIME } from './antigravity-acp-runtime'

const allowed = ANTIGRAVITY_LAUNCH_SPEC.managedRuntimeUpdatesAllowed

it("keeps Orca's installed Antigravity server at the release this build pins", () => {
  expect(ANTIGRAVITY_ACP_RUNTIME.updatesToPin).toBe(true)
  expect(allowed({})).toBe(true)
  expect(allowed({ antigravityServerAutoUpdateEnabled: true })).toBe(true)
})

it('stops updating it by itself when its kill switch is off', () => {
  expect(allowed({ antigravityServerAutoUpdateEnabled: false })).toBe(false)
})

it("keeps updating it with Orca's agy turned off, since chats then run on the server", () => {
  expect(allowed({ antigravityManagedAgyEnabled: false })).toBe(true)
  // The host's agy is never Orca's server, so it has no server to update.
  expect(ANTIGRAVITY_LAUNCH_SPEC.hostBackend.spec.managedRuntimeUpdatesAllowed).toBeUndefined()
})
