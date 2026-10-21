import type {
  AgentSessionOptionCatalog,
  CatalogModel
} from '../../../src/shared/agent-session-option-catalog'

export function mobileOmpSessionCatalog(
  catalog: AgentSessionOptionCatalog,
  models: CatalogModel[] | null | undefined,
  modelSwitchCommand: string | undefined
): AgentSessionOptionCatalog {
  return {
    ...catalog,
    models: models ?? catalog.models,
    modelApply: {
      ...catalog.modelApply,
      midSession: modelSwitchCommand === 'orca-model' ? catalog.modelApply.midSession : undefined
    }
  }
}
