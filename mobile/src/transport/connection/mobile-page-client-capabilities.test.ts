import { describe, expect, it } from 'vitest'
import { notePageVersion, watchPageClientCapabilities } from './mobile-page-client-capabilities'
import { settleMobileRuntimeCapabilities } from './mobile-runtime-capability-negotiation'

const ROWS = { clientCapabilities: expect.arrayContaining(['browser.clientHost.rows.v1']) }

async function advertised(hostId: string): Promise<unknown> {
  let sent: unknown
  await settleMobileRuntimeCapabilities(async (_method, params) => {
    sent = params
    return { id: '1', ok: true, result: {} }
  }, hostId)
  return sent
}

describe('page-drawn client capabilities', () => {
  it('advertises This-device rows only while the page loaded for that host draws them', async () => {
    let changes = 0
    const stop = watchPageClientCapabilities('host-a', () => changes++)
    expect(await advertised('host-a')).not.toEqual(ROWS)

    notePageVersion('host-a', 4)
    expect(await advertised('host-a')).toEqual(ROWS)
    expect(await advertised('host-b')).not.toEqual(ROWS)

    // An older cached page replaces it: the host must stop sending rows that page would stream.
    notePageVersion('host-a', 3)
    expect(await advertised('host-a')).not.toEqual(ROWS)
    expect(changes).toBe(2)
    stop()
  })

  it('sends the new list when the page changes while the handshake advertises the old one', async () => {
    const sent: unknown[] = []
    await settleMobileRuntimeCapabilities(async (_method, params) => {
      sent.push(params)
      // The page for this host finishes loading before the host replies.
      notePageVersion('host-c', 4)
      return { id: '1', ok: true, result: {} }
    }, 'host-c')
    expect(sent).toHaveLength(2)
    expect(sent[0]).not.toEqual(ROWS)
    expect(sent[1]).toEqual(ROWS)
  })
})
