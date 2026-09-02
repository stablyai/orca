import { removePromotedSettingsFromContent } from './codex-config-settings-removal'
import { upsertPromotedSettingsInContent } from './codex-config-settings-upsert'

export function preserveRuntimeConflictValues(
  content: string,
  values: ReadonlyMap<string, string | null>
): { content: string; keys: ReadonlySet<string> } {
  let result = content
  const keys = new Set<string>()
  for (const [key, raw] of values) {
    const previous = result
    result =
      raw === null
        ? removePromotedSettingsFromContent(result, new Set([key]))
        : upsertPromotedSettingsInContent(result, new Map([[key, raw]]))
    if (result !== previous) {
      keys.add(key)
    }
  }
  // Why: only schema-new ambiguous keys stay runtime-local; every unrelated setting still mirrors.
  return { content: result, keys }
}
