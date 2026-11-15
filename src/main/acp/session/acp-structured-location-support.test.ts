import { describe, expect, it } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type { AgentSessionExecutionLocation } from '../../../shared/agent-session/lifecycle/agent-session-record'
import { acpLaunchSpecFor } from '../launch/acp-launch-registry'
import { supportsAcpStructuredLocation } from './acp-structured-location-support'

const LOCAL_LOCATION: AgentSessionExecutionLocation = {
  executionHostId: LOCAL_EXECUTION_HOST_ID,
  wslDistro: null,
  workspaceId: 'ws-1',
  workspaceKind: 'folder'
}

describe('supportsAcpStructuredLocation', () => {
  it('accepts antigravity on a supervised local host via its host backend', () => {
    const antigravitySpec = acpLaunchSpecFor('antigravity')
    expect(antigravitySpec).not.toBeNull()
    if (!antigravitySpec) {
      return
    }

    expect(supportsAcpStructuredLocation(antigravitySpec, LOCAL_LOCATION, () => true)).toBe(true)
  })

  it('rejects an unpinned managed runtime when host backend is absent', () => {
    const antigravitySpec = acpLaunchSpecFor('antigravity')
    expect(antigravitySpec).not.toBeNull()
    if (!antigravitySpec || !antigravitySpec.managedRuntime) {
      return
    }

    const specWithoutHostBackend = {
      ...antigravitySpec,
      hostBackend: undefined,
      managedRuntime: {
        ...antigravitySpec.managedRuntime,
        pin: () => null
      }
    }

    expect(supportsAcpStructuredLocation(specWithoutHostBackend, LOCAL_LOCATION, () => true)).toBe(
      false
    )
  })
})
