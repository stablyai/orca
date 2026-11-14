import type { AgentSessionModelOption } from '../../../shared/agent-session/agent-session-wire'

/** The listed row a configured model runs: an exact row first, else the row a configured alias
 *  resolves to. Its alias rows run the same model, so a chat saved on one shows the configured effort. */
export function configuredCatalogChoice(
  models: readonly AgentSessionModelOption[],
  configuredModel: string | undefined
): { modelId: string; sameModelIds?: string[] } | undefined {
  if (!configuredModel) {
    return undefined
  }
  const namedRow =
    models.find((row) => row.id === configuredModel) ??
    models.find((row) => row.resolvedModel === configuredModel)
  const configuredRow =
    (namedRow?.resolvedModel && namedRow.resolvedModel !== namedRow.id
      ? models.find((row) => row.id === namedRow.resolvedModel)
      : undefined) ?? namedRow
  const modelId = configuredRow?.id ?? configuredModel
  const sameModelIds = models
    .filter((row) => row.id !== modelId && row.resolvedModel === modelId)
    .map((row) => row.id)
  return { modelId, ...(sameModelIds.length > 0 ? { sameModelIds } : {}) }
}
