import { describe, expect, it } from 'vitest'
import { isAppKitSceneSelfDeadlockSample } from './appkit-scene-self-deadlock'
import {
  BACKGROUND_SCENE_WAIT_SAMPLE,
  SCENE_SELF_DEADLOCK_SAMPLE,
  TRANSIENT_SCENE_WAIT_SAMPLE
} from './appkit-scene-self-deadlock.test-fixture'

describe('isAppKitSceneSelfDeadlockSample', () => {
  it('recognizes a main thread parked in the FrontBoard scene self-wait for every sample', () => {
    expect(isAppKitSceneSelfDeadlockSample(SCENE_SELF_DEADLOCK_SAMPLE)).toBe(true)
  })

  it('rejects a scene wait that released the queue during the capture', () => {
    expect(isAppKitSceneSelfDeadlockSample(TRANSIENT_SCENE_WAIT_SAMPLE)).toBe(false)
  })

  it('rejects the scene wait when it is on a background thread', () => {
    expect(isAppKitSceneSelfDeadlockSample(BACKGROUND_SCENE_WAIT_SAMPLE)).toBe(false)
  })
})
