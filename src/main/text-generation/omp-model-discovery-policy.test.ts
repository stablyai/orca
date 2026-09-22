import { expect, it } from 'vitest'
import { getAgentModelProbeSpec } from '../../shared/agent-model-probe-spec'
import { finalizeModelDiscoveryOutput } from './commit-message-model-discovery-policy'

const output = JSON.stringify({
  models: [
    {
      provider: 'provider',
      id: 'exact-model',
      selector: 'provider/exact-model',
      name: 'Exact model'
    }
  ]
})
it('keeps the OMP configured default out of generic terminal discovery results', () => {
  const spec = getAgentModelProbeSpec('omp')
  if (!spec) {
    throw new Error('Missing OMP probe spec')
  }
  expect(finalizeModelDiscoveryOutput(spec, output, '', 0)).toMatchObject({
    success: true,
    defaultModelId: 'provider/exact-model',
    models: [{ id: 'provider/exact-model' }]
  })
})
