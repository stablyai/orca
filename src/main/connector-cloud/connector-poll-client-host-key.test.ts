// A machine whose host key loads after its first hello (orca serve starts its connector before its
// RPC server) says hello again at once, with the key, so teammates can hand messages off to it.
import { describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { pollClientHarness, settle } from './connector-poll-client.test-fixture'
import { fakeSeam } from './fake-connector-seam.test-fixture'

const h = pollClientHarness()

describe('the hello and the host key', () => {
  it('says a new hello carrying hostKey once the key is ready, and none while it is unchanged', async () => {
    const runtime = new OrcaRuntimeService()
    let key: string | null = null
    const { client } = h.startClient(fakeSeam(), undefined, (machine) => {
      machine.shareSend = {
        hostKey: () => key,
        deliver: async () => ({ outcome: 'accepted' })
      }
    })
    // As the connector install wires it: the key's arrival is a hello input.
    runtime.onBotShareHostKeyReady(() => client.sayChanged())
    await settle()
    expect(h.fake.hellos).toHaveLength(1)
    expect(h.fake.hellos[0]).not.toHaveProperty('hostKey')
    key = `${'A'.repeat(43)}=`
    runtime.notifyBotShareHostKeyReady()
    await settle()
    expect(h.fake.hellos).toHaveLength(2)
    expect(h.fake.hellos[1]).toMatchObject({ hostKey: key })
    runtime.notifyBotShareHostKeyReady()
    await settle()
    expect(h.fake.hellos).toHaveLength(2)
    client.stop()
  })
})
