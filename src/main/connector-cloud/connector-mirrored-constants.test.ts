import { describe, expect, it } from 'vitest'
import { CONNECTOR_CONNECT_SOURCES as CLOUD_CONNECT_SOURCES } from '../../../cloud/packages/connector-contract/src/connect-messages'
import { ShareResolvedFields } from '../../../cloud/packages/connector-contract/src/share-messages'
import * as z from 'zod'
import {
  CONNECTOR_CONNECT_SOURCES,
  ConnectorDelivery
} from '../../shared/connectors/connector-cloud-contract'

// src/shared copies the cloud contract (the CLI can't reach cloud files); a copy that drifts sends
// trips to routes the cloud doesn't serve.
describe('mirrored connector constants', () => {
  it('lists the connect sources the cloud serves', () => {
    expect(CONNECTOR_CONNECT_SOURCES).toEqual(CLOUD_CONNECT_SOURCES)
  })

  it("reads a share_resolved's linked sources as the cloud writes them, and an old one without", () => {
    const old = {
      kind: 'share_resolved',
      deliveryId: 'd1',
      seq: 1,
      expiresAt: 1,
      conversation: { source: 'orca', externalId: 's1' },
      shareId: 's1',
      botId: 'bot-1',
      email: 'alice@example.com',
      accountId: 'acct-1'
    }
    const linked = { ...old, linkedSources: [...CLOUD_CONNECT_SOURCES] }
    expect(z.object(ShareResolvedFields).parse(linked)).toMatchObject({
      linkedSources: CLOUD_CONNECT_SOURCES
    })
    expect(ConnectorDelivery.parse(linked)).toMatchObject({ linkedSources: CLOUD_CONNECT_SOURCES })
    expect(ConnectorDelivery.parse(old)).not.toHaveProperty('linkedSources')
    // A later change of sources, for a share the host already lists as that account: no email.
    const { email: _email, ...later } = linked
    expect(z.object(ShareResolvedFields).parse(later)).not.toHaveProperty('email')
    expect(ConnectorDelivery.parse(later)).toMatchObject({ linkedSources: CLOUD_CONNECT_SOURCES })
  })
})
