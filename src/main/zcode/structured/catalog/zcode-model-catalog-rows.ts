import type { AgentSessionModelOption } from '../../../../shared/agent-session/agent-session-wire'

// The snapshot → catalog-row conversion: the backend's `model.available` names only the live
// selection, so the account push's declared ids join the rows to form the plan's real menu.

export type ZcodeCatalogModelRows = {
  declaredModels: readonly { providerId: string; modelId: string }[]
  /** The snapshot's own thought-level menu, covering declared models it carries no details for. */
  fallbackLevels: readonly { value: string; label: string }[]
}

/** The listing rows a snapshot's `settings.model.available` carries, with the account default marked. */
export function readZcodeCatalogModelRows(
  available: unknown,
  current: unknown,
  declared: ZcodeCatalogModelRows
): AgentSessionModelOption[] {
  const entries = Array.isArray(available) ? available : []
  // `settings.model.current` carries providerId/modelId directly; only `available[].ref` wraps.
  const currentProvider = readString(readRecord(current)?.providerId)
  const currentModel = readString(readRecord(current)?.modelId)
  const rows = entries.flatMap((entry) => {
    const record = readRecord(entry)
    const ref = readRecord(record?.ref)
    const providerId = readString(ref?.providerId)
    const modelId = readString(ref?.modelId)
    if (!providerId || !modelId) {
      return []
    }
    const id = `${providerId}/${modelId}`
    const reasoning = readRecord(record?.reasoning)
    const providerLabel = readString(record?.providerLabel)
    const defaultLevel = readString(reasoning?.defaultLevel)
    const efforts = Array.isArray(reasoning?.levels)
      ? reasoning.levels.flatMap((level) => {
          const item = readRecord(level)
          const value = readString(item?.value)
          return value ? [{ value, label: readString(item?.label) ?? value }] : []
        })
      : []
    return [
      {
        id,
        label: readString(record?.label) ?? modelId,
        ...(providerLabel ? { description: providerLabel } : {}),
        isDefault: providerId === currentProvider && modelId === currentModel,
        ...(defaultLevel ? { declaredDefaultEffort: defaultLevel } : {}),
        efforts
      }
    ]
  })
  const known = new Set(rows.map((row) => row.id))
  for (const declaredModel of declared.declaredModels) {
    const id = `${declaredModel.providerId}/${declaredModel.modelId}`
    if (known.has(id)) {
      continue
    }
    rows.push({
      id,
      label: declaredModel.modelId,
      isDefault: false,
      efforts: [...declared.fallbackLevels]
    })
  }
  return rows
}

export function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: zcode app-server frames and provider responses own these payload shapes.
      (value as Record<string, unknown>)
    : null
}

export function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}
