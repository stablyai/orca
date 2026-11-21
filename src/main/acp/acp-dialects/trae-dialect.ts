import type { AcpAdvertisedEfforts, AcpDialect } from './acp-dialect'
import type { ModelInfo } from '../generated/acp-protocol.generated'
import { projectTraeHistoryFrame } from '../../trae/trae-history-projection'
import { traeAsyncTaskNotification } from './trae-async-tasks'

const REASONING_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

function familyEfforts(family: string, models: readonly ModelInfo[]): AcpAdvertisedEfforts {
  const variants = new Set(models.map((model) => model.modelId))
  return {
    efforts: REASONING_LEVELS.filter((effort) => variants.has(`${family}/${effort}`)).map(
      (effort) => ({ value: effort, label: effort })
    )
  }
}

export const TRAE_ACP_DIALECT: AcpDialect = {
  clientCapabilities: {
    elicitation: { form: {} },
    _meta: { jetbrains: { air: { version: 1, capabilities: ['asyncTasks'] } } }
  },
  notification: traeAsyncTaskNotification,
  sessionlessRequests: ['elicitation/create'],
  familyEfforts,
  historyProjection: projectTraeHistoryFrame,
  historyStartsWithAssistant: true,
  preferSessionModels: true
}
