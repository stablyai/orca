type JsonRecord = Record<string, unknown>

export function untilFlags(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value
    .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    .flatMap((entry) => ['--until', entry])
}

export function zoomMode(value: unknown): 'toggle' | 'on' | 'off' {
  return value === 'on' || value === 'off' ? value : 'toggle'
}

export function paneTargetFlags(params: JsonRecord): string[] {
  const paneId = optionalString(params.pane_id)
  return paneId ? ['--pane', paneId] : ['--current']
}

export function outputMatchFlags(params: JsonRecord): string[] {
  const match = optionalString(params.match)
  const regex = optionalString(params.regex)
  if (match) {
    return ['--match', assertNoLeadingDash(match, 'match')]
  }
  if (regex) {
    return ['--regex', assertNoLeadingDash(regex, 'regex')]
  }
  throw new Error('Missing Herdr request parameter: match or regex')
}

export function renameTargetFlags(value: unknown): string[] {
  const name = optionalString(value)
  return name ? [assertNoLeadingDash(name, 'name')] : ['--clear']
}

export function agentStartArgs(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    return []
  }
  return ['--', ...value.map((entry) => String(entry))]
}

export function swapTargetFlags(params: JsonRecord): string[] {
  const sourcePaneId = optionalString(params.source_pane_id)
  const targetPaneId = optionalString(params.target_pane_id)
  if (sourcePaneId && targetPaneId) {
    return ['--source-pane', sourcePaneId, '--target-pane', targetPaneId]
  }
  const direction = optionalString(params.direction)
  if (direction) {
    return ['--direction', direction, ...paneTargetFlags(params)]
  }
  throw new Error(
    'Missing Herdr request parameter: source_pane_id and target_pane_id, or direction'
  )
}

export function moveDestinationFlags(params: JsonRecord): string[] {
  const destination = params.destination
  if (!destination || typeof destination !== 'object') {
    throw new Error('Missing Herdr request parameter: destination')
  }
  const record = destination as JsonRecord
  const type = record.type
  if (type === 'tab') {
    return [
      '--tab',
      requiredString(record.tab_id, 'destination.tab_id'),
      '--split',
      requiredString(record.split, 'destination.split'),
      ...optionalFlag('--target-pane', record.target_pane_id),
      ...optionalFlag('--ratio', record.ratio),
      ...focusFlag(record.focus)
    ]
  }
  if (type === 'new_tab') {
    return [
      '--new-tab',
      ...optionalFlag('--workspace', record.workspace_id),
      ...optionalFlag('--label', record.label),
      ...focusFlag(record.focus)
    ]
  }
  if (type === 'new_workspace') {
    return [
      '--new-workspace',
      ...optionalFlag('--label', record.label),
      ...optionalFlag('--tab-label', record.tab_label),
      ...focusFlag(record.focus)
    ]
  }
  throw new Error(`Unsupported pane.move destination type: ${String(type)}`)
}

function focusFlag(value: unknown): string[] {
  if (value === undefined || value === null) {
    return []
  }
  return value ? ['--focus'] : ['--no-focus']
}

export function optionalFlag(name: string, value: unknown): string[] {
  return value === undefined || value === null ? [] : [name, String(value)]
}

export function optionalLabelFlag(value: unknown): string[] {
  if (value === undefined || value === null) {
    return []
  }
  return ['--label', assertNoLeadingDash(String(value), 'label')]
}

export function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function requiredString(value: unknown, name: string): string {
  const result = optionalString(value)
  if (!result) {
    throw new Error(`Missing Herdr request parameter: ${name}`)
  }
  return result
}

export function requiredStrings(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    throw new Error(`Missing Herdr request parameter: ${name}`)
  }
  return value.map((entry) => assertNoLeadingDash(entry, name))
}

export function tokenFlags(value: unknown): string[] {
  return Object.entries(asRecord(value)).flatMap(([key, token]) =>
    token === null ? ['--clear-token', key] : ['--token', `${key}=${String(token)}`]
  )
}

export function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' ? (value as JsonRecord) : {}
}

export function assertNoLeadingDash(value: string, name: string): string {
  if (value.startsWith('-')) {
    throw new Error(`Herdr request parameter must not start with a dash: ${name}`)
  }
  return value
}
