import { scanStructuredSettingLines } from './config-toml-promoted-setting-values'

export function removePromotedSettingsFromContent(
  content: string,
  removals: ReadonlySet<string>
): string {
  if (removals.size === 0) {
    return content
  }
  const lines = content.split('\n')
  const indexes = scanStructuredSettingLines(lines)
    .filter((setting) => removals.has(setting.structuredKey))
    .map((setting) => setting.index)
  for (const index of indexes.toReversed()) {
    lines.splice(index, 1)
  }
  return lines.join('\n')
}
