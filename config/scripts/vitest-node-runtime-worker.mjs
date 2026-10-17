import { init, runBaseTests, setupEnvironment } from 'vitest/worker'
import {
  decodeNodeRuntimeMessage,
  encodeNodeRuntimeMessage
} from './vitest-node-runtime-ipc-codec.mjs'

if (!process.send) {
  throw new Error('Node Vitest worker requires an IPC channel')
}
const send = process.send.bind(process)

init({
  post: (response) => send(response),
  on: (callback) => process.on('message', callback),
  off: (callback) => process.off('message', callback),
  serialize: encodeNodeRuntimeMessage,
  deserialize: decodeNodeRuntimeMessage,
  teardown: () => process.removeAllListeners('message'),
  runTests: (state, traces) => runBaseTests('run', state, traces),
  collectTests: (state, traces) => runBaseTests('collect', state, traces),
  setup: setupEnvironment
})
