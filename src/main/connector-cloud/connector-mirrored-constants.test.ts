import { describe, expect, it } from 'vitest'
import { CONNECTOR_CONNECT_SOURCES as CLOUD_CONNECT_SOURCES } from '../../../cloud/packages/connector-contract/src/connect-messages'
import { CONNECTOR_CONNECT_SOURCES } from '../../shared/connectors/connector-cloud-contract'

// src/shared copies the cloud contract (the CLI can't reach cloud files); a copy that drifts sends
// trips to routes the cloud doesn't serve.
describe('mirrored connector constants', () => {
  it('lists the connect sources the cloud serves', () => {
    expect(CONNECTOR_CONNECT_SOURCES).toEqual(CLOUD_CONNECT_SOURCES)
  })
})
