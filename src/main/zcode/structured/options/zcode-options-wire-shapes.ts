import { formatZcodeModelOption } from '../launch/zcode-structured-launch-resolution'
import { readRecord, readString, readZcodeLevelChoices } from '../catalog/zcode-model-catalog-rows'
import type { ZcodeModelAvailability } from './zcode-structured-options'

/** Parse one `model.available` entry; rows without a resolvable id are skipped. */
export function readAvailabilityRow(entry: unknown): ZcodeModelAvailability[] {
  const record = readRecord(entry)
  const ref = readRecord(record?.ref)
  const providerId = readString(ref?.providerId)
  const modelId = readString(ref?.modelId)
  if (!providerId || !modelId) {
    return []
  }
  const reasoning = readRecord(record?.reasoning)
  return [
    {
      id: formatZcodeModelOption({ providerId, modelId }),
      label: readString(record?.label) ?? modelId,
      ...(readString(record?.providerLabel)
        ? { providerLabel: readString(record?.providerLabel)! }
        : {}),
      ...(typeof record?.contextWindow === 'number' ? { contextWindow: record.contextWindow } : {}),
      reasoningLevels: readZcodeLevelChoices(reasoning?.levels),
      ...(readString(reasoning?.defaultLevel)
        ? { defaultLevel: readString(reasoning?.defaultLevel)! }
        : {})
    }
  ]
}

/** The `contextUsage` wire shape a live-options answer carries, stamped at build time. */
export function contextUsageField(contextUsage: { used?: number; window?: number }) {
  const at = Date.now()
  return {
    current: {
      ...(typeof contextUsage.window === 'number'
        ? { window: { tokens: contextUsage.window, capturedAt: at } }
        : {}),
      ...(typeof contextUsage.used === 'number'
        ? {
            used: {
              kind: 'report' as const,
              model: '',
              usedTokens: contextUsage.used,
              windowTokens: contextUsage.window ?? 0,
              percentage:
                contextUsage.window && contextUsage.window > 0
                  ? (contextUsage.used / contextUsage.window) * 100
                  : 0,
              categories: [],
              capturedAt: at
            }
          }
        : {})
    }
  }
}
