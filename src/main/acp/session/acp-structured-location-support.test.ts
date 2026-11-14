import { expect, it } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type { AgentSessionExecutionLocation } from '../../../shared/agent-session/lifecycle/agent-session-record'
import {
  supportsAcpStructuredLocation,
  type AcpStructuredLocationSpec
} from './acp-structured-location-support'

const local: AgentSessionExecutionLocation = {
  executionHostId: LOCAL_EXECUTION_HOST_ID,
  wslDistro: null,
  workspaceId: 'workspace',
  workspaceKind: 'folder'
}

it('allows a local Windows ACP chat through a declared host backend when no managed release exists', () => {
  const hostOnly = {
    managedRuntime: { pin: () => null },
    hostBackend: {}
  } satisfies AcpStructuredLocationSpec
  const managedOnly = {
    managedRuntime: { pin: () => null }
  } satisfies AcpStructuredLocationSpec

  expect(supportsAcpStructuredLocation(hostOnly, local, () => true)).toBe(true)
  expect(supportsAcpStructuredLocation(managedOnly, local, () => true)).toBe(false)
  expect(
    supportsAcpStructuredLocation(hostOnly, { ...local, wslDistro: 'Ubuntu' }, () => true)
  ).toBe(false)
  expect(
    supportsAcpStructuredLocation(hostOnly, { ...local, executionHostId: 'ssh:host' }, () => true)
  ).toBe(false)
})
