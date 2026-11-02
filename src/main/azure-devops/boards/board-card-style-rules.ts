import type { AzureDevOpsBoardStyleRule } from '../../../shared/azure-devops/boards-types'

type RawRuleSettings = { 'background-color'?: string; 'title-color'?: string }
type RawClause = {
  fieldName?: string
  index?: number
  logicalOperator?: string
  operator?: string
  value?: string
}
type RawRule = {
  name?: string
  isEnabled?: string
  clauses?: RawClause[]
  settings?: RawRuleSettings
}

export type RawCardRules = {
  rules?: { fill?: RawRule[]; tagStyle?: RawRule[] }
}

// Why: the API spells the flag "True" on tag rules and "true" on fill rules.
function isEnabled(rule: RawRule): boolean {
  return rule.isEnabled?.toLowerCase() === 'true'
}

export function parseTagColors(raw: RawCardRules | null): Record<string, string> {
  const tagColors: Record<string, string> = {}
  for (const rule of raw?.rules?.tagStyle ?? []) {
    const color = rule.settings?.['background-color']
    if (isEnabled(rule) && rule.name && color) {
      tagColors[rule.name] = color
    }
  }
  return tagColors
}

export function parseStyleRules(raw: RawCardRules | null): AzureDevOpsBoardStyleRule[] {
  const styleRules: AzureDevOpsBoardStyleRule[] = []
  for (const rule of raw?.rules?.fill ?? []) {
    const backgroundColor = rule.settings?.['background-color'] ?? null
    const titleColor = rule.settings?.['title-color'] ?? null
    const ordered = (rule.clauses ?? [])
      .filter((c) => c.fieldName && c.operator)
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    if (
      !isEnabled(rule) ||
      !rule.name ||
      ordered.length === 0 ||
      (!backgroundColor && !titleColor)
    ) {
      continue
    }
    styleRules.push({
      name: rule.name,
      clauses: ordered.map((c, position) => ({
        fieldName: c.fieldName ?? '',
        operator: (c.operator ?? '').toLowerCase(),
        value: c.value ?? '',
        logicalOperator:
          position === 0 ? null : c.logicalOperator?.toLowerCase() === 'or' ? 'or' : 'and'
      })),
      backgroundColor,
      titleColor
    })
  }
  return styleRules
}
