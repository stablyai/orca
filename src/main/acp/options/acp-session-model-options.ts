import type {
  AgentSessionModelOption,
  AgentSessionOptionChoice
} from '../../../shared/agent-session/agent-session-wire'
import type { AcpDialect } from '../acp-dialects/acp-dialect'
import type { ModelInfo } from '../generated/acp-protocol.generated'

/** Builds the picker's per-model rows from the session menu, advertising dialect-known efforts
 *  where the agent reports them and leaving non-running models' menus unknown. */
export function buildSessionModelOptions(args: {
  listed: { id: string; label: string; description?: string }[]
  currentModel: string | undefined
  sessionEfforts: AgentSessionOptionChoice[]
  hasModelOrEffort: boolean
  availableModels?: readonly ModelInfo[]
  dialect: Pick<AcpDialect, 'modelEfforts'>
}): AgentSessionModelOption[] {
  const { listed, currentModel, sessionEfforts, hasModelOrEffort, availableModels, dialect } = args
  return listed.map((model) => {
    const info = availableModels?.find((e) => e.modelId === model.id) ?? {
      modelId: model.id,
      name: model.label,
      ...(model.description && { description: model.description })
    }
    const advertised = info ? dialect.modelEfforts?.(info) : undefined
    // A current-session menu supplies no negative evidence about an unobserved model.
    const sessionMenu =
      model.id === currentModel
        ? { efforts: sessionEfforts }
        : hasModelOrEffort && !advertised
          ? { efforts: [], effortsKnown: false as const }
          : { efforts: [] }
    return {
      ...model,
      isDefault: false,
      ...(advertised && (advertised.efforts.length > 0 || model.id !== currentModel)
        ? advertised
        : sessionMenu),
      ...(advertised?.declaredDefaultEffort !== undefined && {
        declaredDefaultEffort: advertised.declaredDefaultEffort
      })
    }
  })
}
