import { expect, it } from 'vitest'
import { jsonRpcAnswerId } from './relayed-json-rpc-lines'

it('reads an answer id wherever the id sits, for results and errors, and never a request id', () => {
  const lines = {
    resultFirst: '{"jsonrpc":"2.0","id":7,"result":{"stopReason":"end_turn"}}',
    resultLast: '{"jsonrpc":"2.0","result":{"stopReason":"end_turn"},"id":7}',
    errorFirst: '{"jsonrpc":"2.0","id":7,"error":{"code":-32603,"message":"failed"}}',
    errorLast: '{"jsonrpc":"2.0","error":{"code":-32603,"message":"failed"},"id":7}',
    stringId: '{"jsonrpc":"2.0","error":{"code":1,"message":"x"},"id":"a7"}',
    request: '{"jsonrpc":"2.0","id":7,"method":"session/request_permission","params":{}}',
    notification: '{"jsonrpc":"2.0","method":"session/update","params":{"result":1,"id":7}}'
  }
  expect(
    Object.fromEntries(Object.entries(lines).map(([k, line]) => [k, jsonRpcAnswerId(line)]))
  ).toEqual({
    resultFirst: 7,
    resultLast: 7,
    errorFirst: 7,
    errorLast: 7,
    stringId: 'a7',
    request: null,
    notification: null
  })
})
