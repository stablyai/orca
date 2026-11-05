import { expect, it } from 'vitest'
import { acpStructuredAgentDefinition } from './acp-structured-agent-definitions'
import { acpLaunchSpecFor } from './acp-launch-specs'
import { AcpStructuredOptions } from './acp-structured-options'
import { noteAcpForkVersion, observeAcpForkSupport, readAcpForkSupport } from './acp-fork-support'

it('keeps unknown separate from initialized negative support, and forgets the negative on upgrade', () => {
  const options = new AcpStructuredOptions()
  expect(options.read().forkSupport).toBe('unknown')
  const unsupported = { protocolVersion: 1, agentCapabilities: {} }
  options.adoptInitialize(unsupported)
  noteAcpForkVersion('omp', '17.0.5')
  observeAcpForkSupport('omp', unsupported)
  expect(options.read().forkSupport).toBe('unsupported')
  expect(readAcpForkSupport('omp')).toBe('unsupported')
  noteAcpForkVersion('omp', '17.0.6')
  expect(readAcpForkSupport('omp')).toBe('unknown')
  const supported = { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { fork: {} } } }
  observeAcpForkSupport('omp', supported)
  options.adoptInitialize(supported)
  expect(readAcpForkSupport('omp')).toBe('supported')
  expect(options.read().forkSupport).toBe('supported')
})

it('offers imported-tip forks only for agents whose history observes terminal evidence', () => {
  for (const agent of ['omp', 'opencode', 'opencode2']) {
    expect(acpStructuredAgentDefinition(acpLaunchSpecFor(agent)!).capabilities.fork).toBe('tip')
  }
  expect(acpStructuredAgentDefinition(acpLaunchSpecFor('grok')!).capabilities.fork).toBeUndefined()
})
