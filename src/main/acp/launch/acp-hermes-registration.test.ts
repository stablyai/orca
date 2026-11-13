import { describe, expect, it } from 'vitest'
import { acpLaunchSpecFor } from './acp-launch-registry'
import { structuredAgentRuntimeMetadata } from '../../runtime/agent-session/installation/structured-agent-runtime-metadata'

describe('hermes structured-session registration', () => {
  it('resolves an ACP launch spec', () => {
    expect(acpLaunchSpecFor('hermes')?.command).toBe('hermes')
  })

  it('publishes runtime metadata for the same agent', () => {
    expect(structuredAgentRuntimeMetadata('hermes')?.definition.agent).toBe('hermes')
  })
})
