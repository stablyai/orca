import { PassThrough } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import { JsonlRpcPeer } from '../jsonl-rpc/peer'
import { agentSessionRecordFixture } from '../native-chat/agent-session-record-test-fixture'
import {
  closePiRpcAdapterFixtures,
  file,
  sessionId,
  setup
} from './rpc-session-adapter.test-fixture'

afterEach(closePiRpcAdapterFixtures)

it('sends Pi the current session name and accepts its success response without data', async () => {
  const h = await setup()
  const input = new PassThrough()
  const output = new PassThrough()
  const peer = new JsonlRpcPeer(input, output)
  const request = vi.spyOn(h.connection, 'request').mockImplementation(peer.request.bind(peer))
  try {
    const done = h.adapter.renameProviderSession({
      record: agentSessionRecordFixture({ sessionId, provider: 'pi' }),
      providerSessionId: file,
      name: 'Release notes'
    })
    expect(JSON.parse(output.read().toString())).toEqual({
      type: 'set_session_name',
      id: 'orca-1',
      name: 'Release notes'
    })
    // Pi 1.1.0 rpc-mode set_session_name returns success(id, command), with no data field.
    input.write('{"id":"orca-1","type":"response","command":"set_session_name","success":true}\n')
    await expect(done).resolves.toBeUndefined()
  } finally {
    request.mockRestore()
    peer.close()
  }
})
