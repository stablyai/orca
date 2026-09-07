import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import {
  parseLegacyAdmissionProbeArguments,
  probeLegacyAdmission
} from './probe-relay-legacy-admission.mjs'

function socketClosingWith(code, observed) {
  return class extends EventEmitter {
    constructor(url) {
      super()
      observed.url = url
      queueMicrotask(() => this.emit('open'))
    }

    send(payload) {
      observed.payload = JSON.parse(payload)
      queueMicrotask(() => this.emit('close', code))
    }

    terminate() {}
  }
}

function nativeSocketClosingWith(code) {
  return class extends EventTarget {
    constructor() {
      super()
      queueMicrotask(() => this.dispatchEvent(new Event('open')))
    }

    send() {
      const event = new Event('close')
      Object.defineProperty(event, 'code', { value: code })
      queueMicrotask(() => this.dispatchEvent(event))
    }

    close() {}
  }
}

const config = { cellOrigin: 'https://c2.relay.example.com' }
const random = (length) => Buffer.alloc(length, length)

test('accepts only a canonical cell origin', () => {
  assert.deepEqual(
    parseLegacyAdmissionProbeArguments(['--cell-origin', config.cellOrigin]),
    config
  )
  assert.throws(
    () => parseLegacyAdmissionProbeArguments(['--cell-origin', `${config.cellOrigin}/path`]),
    /canonical/
  )
})

test('proves admission with a synthetic invalid credential and exposes no identifier', async () => {
  const observed = {}
  assert.deepEqual(
    await probeLegacyAdmission(config, {
      WebSocket: socketClosingWith(4409, observed),
      randomBytes: random
    }),
    { accepting: true }
  )
  assert.match(observed.url, /^wss:\/\/c2\.relay\.example\.com\/v1\/connect\/[A-Za-z0-9_-]{16}$/)
  assert.deepEqual(Object.keys(observed.payload).sort(), ['credential', 'mode', 'type', 'v'])
})

test('uses the dependency-free Node WebSocket event API', async () => {
  await assert.doesNotReject(
    probeLegacyAdmission(config, {
      WebSocket: nativeSocketClosingWith(4409),
      randomBytes: random
    })
  )
})

test('rejects the legacy draining close and any unknown outcome', async () => {
  for (const [code, message] of [[4503, /draining/], [4401, /closed with 4401/]]) {
    await assert.rejects(
      probeLegacyAdmission(config, {
        WebSocket: socketClosingWith(code, {}),
        randomBytes: random
      }),
      message
    )
  }
})
