import type { AcpThinkingOptionsFixtureModule } from '../../shared/acp-thinking-options.test-fixture-contract'
import { AcpStructuredOptions } from './acp-structured-options'
import { OMP_ACP_DIALECT } from './acp-dialects/omp-dialect'
import { NewSessionResponseSchema } from './generated/acp-protocol.generated'
import recorded from './fixtures/omp-v17-windows-new-no-model.json'

export function recordedOmpOptions(origin: 'new' | 'loaded', count = 2): AcpStructuredOptions {
  const options = new AcpStructuredOptions(OMP_ACP_DIALECT)
  // The recorded native menu has no model list; these rows are synthetic catalog context.
  options.adoptSession(
    {
      ...NewSessionResponseSchema.parse(recorded),
      models: {
        currentModelId: 'running',
        availableModels: Array.from({ length: count }, (_, index) => ({
          modelId: index === 0 ? 'running' : index === 1 ? 'target' : `model-${index}`,
          name: index === 0 ? 'Running' : index === 1 ? 'Target' : `Model ${index}`
        }))
      }
    },
    origin
  )
  return options
}

export const thinkingOptionsProducer = {
  recordedOmpOptions
} satisfies AcpThinkingOptionsFixtureModule
