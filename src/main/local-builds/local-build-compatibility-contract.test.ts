import { describe, expect, it } from 'vitest'
import { ORCA_APP_BUNDLE_ID } from '../../shared/app-identity'
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
      // Packaging scripts read this JSON; it must carry the runtime identity.
      appId: ORCA_APP_BUNDLE_ID,
      stateSchemaVersion: SCHEMA_VERSION,
      readableStateSchemaVersions: [SCHEMA_VERSION],
      daemonProtocolVersion: PROTOCOL_VERSION,
      attachableDaemonProtocolVersions: [...PREVIOUS_DAEMON_PROTOCOL_VERSIONS, PROTOCOL_VERSION]
    })
  })
})
