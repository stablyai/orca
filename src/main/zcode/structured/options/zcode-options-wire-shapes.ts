import { formatZcodeModelOption } from '../launch/zcode-structured-launch-resolution'
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
  const levels = Array.isArray(reasoning?.levels)
    ? reasoning.levels.flatMap((level) => {
        const item = readRecord(level)
        const value = readString(item?.value)
        return value ? [{ value, label: readString(item?.label) ?? value }] : []
      })
    : []
  return [
    {
      id: formatZcodeModelOption({ providerId, modelId }),
      label: readString(record?.label) ?? modelId,
      ...(readString(record?.providerLabel)
        ? { providerLabel: readString(record?.providerLabel)! }
        : {}),
      ...(typeof record?.contextWindow === 'number' ? { contextWindow: record.contextWindow } : {}),
      reasoningLevels: levels,
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

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: zcode app-server frames and provider responses own these payload shapes.
      (value as Record<string, unknown>)
    : null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}
