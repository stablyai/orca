import assert from 'node:assert/strict'
import test from 'node:test'
import { assertSpreadModel, controlPhase, modeledRelayLoad } from './relay-load-model.mjs'

test('phases are deterministic, bounded, and separated by stream', () => {
  assert.deepEqual(controlPhase(42), controlPhase(42))
  assert.notDeepEqual(controlPhase(42), controlPhase(43))
  const phase = controlPhase(42)
  assert.ok(phase.heartbeatOffsetMs >= 0 && phase.heartbeatOffsetMs < 15_000)
  assert.ok(phase.refreshIntervalMs >= 180_000 && phase.refreshIntervalMs <= 240_000)
  assert.ok(phase.refreshOffsetMs >= 0 && phase.refreshOffsetMs < phase.refreshIntervalMs)
  assert.ok(phase.reconnectJitterMs >= 0 && phase.reconnectJitterMs < 30_000)
})

for (const [controls, expectedPings, expectedRefreshes] of [
  [4_000, 267, 19],
  [10_000, 667, 48]
]) {
  test(`${controls} modeled controls spread heartbeat and token refresh load`, () => {
    const model = modeledRelayLoad(controls)
    assert.equal(Math.round(model.expectedPingRate), expectedPings)
    assert.equal(Math.round(model.expectedRefreshRate), expectedRefreshes)
    assert.doesNotThrow(() => assertSpreadModel(model))
  })
}
