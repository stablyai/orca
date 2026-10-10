import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertRelayLoadRampAccepted,
  relayLoadRunHasDisallowedFailures,
  runRelayLoadWithShutdown
} from './relay-load-run-lifecycle.mjs'

test('always shuts down peers when a load phase fails', async () => {
  const events = []
  await assert.rejects(
    runRelayLoadWithShutdown(
      async () => {
        events.push('run')
        throw new Error('boundary failed')
      },
      async () => events.push('shutdown')
    ),
    /boundary failed/
  )
  assert.deepEqual(events, ['run', 'shutdown'])
})

test('fails immediately when the strict ramp budget is exceeded', () => {
  assert.doesNotThrow(() => assertRelayLoadRampAccepted(0, 0))
  assert.throws(() => assertRelayLoadRampAccepted(1, 0), /ramp exceeded/)
})

test('rejects connection failures during the transition window', () => {
  const result = {
    rampConnectionFailures: 0,
    transitionConnectionFailures: 1,
    steadyConnectionFailures: 0,
    unexpectedCloses: 0,
    protocolErrors: 0,
    refreshErrors: 0,
    socketErrors: 0
  }
  assert.equal(
    relayLoadRunHasDisallowedFailures(result, {
      maxRampConnectionFailures: 0,
      maxUnexpectedCloses: 0
    }),
    true
  )
})

test('allows only explicitly planned transition retries', () => {
  const result = {
    rampConnectionFailures: 0,
    transitionConnectionFailures: 1,
    steadyConnectionFailures: 0,
    unexpectedCloses: 0,
    protocolErrors: 0,
    refreshErrors: 0,
    socketErrors: 0
  }
  const config = {
    allowPlannedTransitionRetries: true,
    maxRampConnectionFailures: 0,
    maxUnexpectedCloses: 0
  }
  assert.equal(relayLoadRunHasDisallowedFailures(result, config), false)
  assert.equal(
    relayLoadRunHasDisallowedFailures({ ...result, steadyConnectionFailures: 1 }, config),
    true
  )
})
