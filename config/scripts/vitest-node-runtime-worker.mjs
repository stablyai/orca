import { parse, stringify } from 'devalue'
import { init, runBaseTests, setupEnvironment } from 'vitest/worker'

if (!process.send) {
  throw new Error('Node Vitest worker requires an IPC channel')
}
const send = process.send.bind(process)

// Preserve RegExp filters and cyclic test results across Bun/Node's JSON-only IPC boundary.
init({
  post: (response) => send(response),
  on: (callback) => process.on('message', callback),
  off: (callback) => process.off('message', callback),
  serialize: stringify,
  deserialize: parse,
  teardown: () => process.removeAllListeners('message'),
  runTests: (state, traces) => runBaseTests('run', state, traces),
  collectTests: (state, traces) => runBaseTests('collect', state, traces),
  setup: setupEnvironment
})
