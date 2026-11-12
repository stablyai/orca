import { expect, it } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type { AgentSessionExecutionLocation } from '../../../shared/agent-session/lifecycle/agent-session-record'
import { ANTIGRAVITY_LAUNCH_SPEC } from '../../antigravity/antigravity-acp-launch-spec'
import type { AcpLaunchSpec } from '../launch/acp-launch-contract'
import { supportsAcpStructuredLocation } from './acp-structured-location-support'

const local: AgentSessionExecutionLocation = {
  executionHostId: LOCAL_EXECUTION_HOST_ID,
  wslDistro: null,
  workspaceId: 'workspace',
  workspaceKind: 'folder'
}

it('allows a local Windows ACP chat through a declared host backend when no managed release exists', () => {
  const unpinnedRuntime = {
    ...ANTIGRAVITY_LAUNCH_SPEC.managedRuntime,
    pin: () => null
  }
  const hostOnly: AcpLaunchSpec = {
    ...ANTIGRAVITY_LAUNCH_SPEC,
    managedRuntime: unpinnedRuntime
  }
  const managedOnly: AcpLaunchSpec = {
    ...ANTIGRAVITY_LAUNCH_SPEC,
    managedRuntime: unpinnedRuntime,
    hostBackend: undefined
  }

  expect(supportsAcpStructuredLocation(hostOnly, local, () => true)).toBe(true)
  expect(supportsAcpStructuredLocation(managedOnly, local, () => true)).toBe(false)
  expect(
    supportsAcpStructuredLocation(hostOnly, { ...local, wslDistro: 'Ubuntu' }, () => true)
  ).toBe(false)
  expect(
    supportsAcpStructuredLocation(hostOnly, { ...local, executionHostId: 'ssh:host' }, () => true)
  ).toBe(false)
})
