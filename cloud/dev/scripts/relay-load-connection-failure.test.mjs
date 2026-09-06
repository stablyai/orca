import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import {
  discardFailedLoadSocket,
  relayLoadFailureReason
} from './relay-load-connection-failure.mjs'

test('classifies only bounded aggregate connection failure reasons', () => {
  assert.equal(relayLoadFailureReason(new Error('relay token exchange failed: 503')), 'token_http_503')
  assert.equal(relayLoadFailureReason(new Error('relay assignment failed: 503')), 'assignment_http_503')
  assert.equal(
    relayLoadFailureReason(
      new Error('relay assignment failed: 503 relay_connection_headroom_exhausted')
    ),
    'assignment_capacity_exhausted'
  )
  for (const status of [400, 429, 500]) {
    assert.equal(
      relayLoadFailureReason(
        new Error(`${`relay assignment failed: ${status}`} relay_capacity_exhausted`)
      ),
      `assignment_http_${status}`
    )
  }
  assert.equal(relayLoadFailureReason(new Error('control closed: 4404 wrong cell')), 'control_close_4404')
  assert.equal(relayLoadFailureReason(new Error('control open timeout')), 'control_open_timeout')
  assert.equal(relayLoadFailureReason(new Error('relay token exchange timeout')), 'token_timeout')
  assert.equal(relayLoadFailureReason(new Error('relay assignment timeout')), 'assignment_timeout')
  assert.equal(
    relayLoadFailureReason(new Error('relay token exchange omitted token')),
    'token_response_invalid'
  )
  assert.equal(
    relayLoadFailureReason(new Error('relay assignment response invalid')),
    'assignment_response_invalid'
  )
  assert.equal(
    relayLoadFailureReason(new Error('Unexpected server response: 503 Service Unavailable')),
    'socket_http_503'
  )
  assert.equal(relayLoadFailureReason(new Error('connect ECONNRESET 127.0.0.1')), 'socket_transport')
  assert.equal(relayLoadFailureReason(new Error('expected host challenge')), 'host_challenge_invalid')
  assert.equal(
    relayLoadFailureReason(new Error('host proof challenge did not decrypt')),
    'host_challenge_decrypt_failed'
  )
  assert.equal(relayLoadFailureReason(new Error('expected host hello acknowledgement')), 'host_ack_invalid')
  assert.equal(relayLoadFailureReason(new Error('host-sensitive detail')), 'unknown')
})

test('absorbs the setup error emitted while discarding a failed socket', () => {
  const socket = new EventEmitter()
  socket.terminate = () => socket.emit('error', new Error('closed before open'))

  assert.doesNotThrow(() => discardFailedLoadSocket(socket))
})
