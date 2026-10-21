import { expect, it } from 'vitest'
import { PI_RPC_RUNTIME_REGISTRATION } from '../pi/rpc-runtime-registration'
import {
  STRUCTURED_AGENT_RUNTIME_METADATA,
  structuredAgentRuntimeMetadata
} from './structured-agent-runtime-metadata'
import {
  STRUCTURED_AGENT_RUNTIME_REGISTRATIONS,
  structuredAgentRuntimeRegistration
} from './structured-agent-runtime-registrations'

it.each(
  STRUCTURED_AGENT_RUNTIME_METADATA.map(
    (metadata, index) => [metadata.definition.agent, metadata, index] as const
  )
)(
  'keeps the metadata and synchronous factory on the same %s registration',
  (agent, metadata, index) => {
    const registration = STRUCTURED_AGENT_RUNTIME_REGISTRATIONS[index]
    expect(registration).toBe(metadata)
    expect(structuredAgentRuntimeRegistration(agent)).toBe(registration)
    expect(structuredAgentRuntimeMetadata(agent)).toBe(registration)
    expect(typeof registration.createAdapter).toBe('function')
    expect(structuredAgentRuntimeRegistration(agent)?.createAdapter).toBe(
      registration.createAdapter
    )
  }
)

it('keeps the standalone Pi registration in the shared roster', () => {
  expect(structuredAgentRuntimeRegistration('pi')).toBe(PI_RPC_RUNTIME_REGISTRATION)
})
