import { describe, expect, it } from 'vitest'
import { formatConnectorRef, parseConnectorRef, type ConnectorRef } from './action-messages.js'

describe('connector refs', () => {
  it.each<[ConnectorRef, string]>([
    [{ source: 'slack', workspaceId: 'T1', containerId: 'C1' }, 'slack:T1:C1'],
    [{ source: 'slack', workspaceId: 'T1', containerId: 'C1', threadId: '1.1' }, 'slack:T1:C1:1.1'],
    // A message not in a thread leaves the thread slot empty.
    [{ source: 'slack', workspaceId: 'T1', containerId: 'C1', messageId: '1.2' }, 'slack:T1:C1::1.2'],
    [
      { source: 'slack', workspaceId: 'T1', containerId: 'C1', threadId: '1.1', messageId: '1.2' },
      'slack:T1:C1:1.1:1.2'
    ],
    [{ source: 'github', workspaceId: '42', containerId: 'acme/web:x', threadId: '5' }, 'github:42:acme%2Fweb%3Ax:5']
  ])('round-trips %j', (ref, written) => {
    expect(formatConnectorRef(ref)).toBe(written)
    expect(parseConnectorRef(written)).toEqual(ref)
  })

  it.each(['slack:T1', 'slack:T1:C1:', 'slack::C1', 'slack:T1:C1::', 'webhook:h:c', 'slack:T1:C1:%zz'])(
    'reads %s as no ref',
    (raw) => expect(parseConnectorRef(raw)).toBeNull()
  )

  it('refuses to write a ref with an empty id', () => {
    expect(() => formatConnectorRef({ source: 'slack', workspaceId: '', containerId: 'C1' })).toThrow()
    expect(() =>
      formatConnectorRef({ source: 'slack', workspaceId: 'T1', containerId: 'C1', threadId: '', messageId: '1.2' })
    ).toThrow()
  })
})
