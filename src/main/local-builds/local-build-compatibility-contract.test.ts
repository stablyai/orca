import { describe, expect, it } from 'vitest'
import { SCHEMA_VERSION } from '../../shared/constants'
import compatibilityContract from '../../shared/local-build-compatibility-contract.json'
import { LOCAL_BUILD_COMPATIBILITY_CONTRACT } from '../../shared/local-build-compatibility-contract'
import {
  PREVIOUS_DAEMON_PROTOCOL_VERSIONS,
  PROTOCOL_VERSION
} from '../daemon/daemon-protocol-version'

describe('packaged local build compatibility contract', () => {
  it('stays aligned with runtime state and daemon constants', () => {
    expect(LOCAL_BUILD_COMPATIBILITY_CONTRACT).toEqual(compatibilityContract)
    expect(compatibilityContract).toMatchObject({
      appId: 'com.stablyai.orca',
      stateSchemaVersion: SCHEMA_VERSION,
      readableStateSchemaVersions: [SCHEMA_VERSION],
      daemonProtocolVersion: PROTOCOL_VERSION,
      attachableDaemonProtocolVersions: [...PREVIOUS_DAEMON_PROTOCOL_VERSIONS, PROTOCOL_VERSION]
    })
  })
})
