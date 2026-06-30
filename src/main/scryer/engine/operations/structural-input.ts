import type { ScryModel, ScryResponsibility } from '../model'
import type { ScryerFieldError } from '../types'
import { failure } from './operation-result'

export type RecordInput = Record<string, unknown>

export function cloneModel(model: ScryModel): ScryModel {
  return JSON.parse(JSON.stringify(model)) as ScryModel
}

export function formatZodPath(path: unknown[], key?: string): string {
  const base = path
    .map((part) => (typeof part === 'number' ? `[${part}]` : String(part)))
    .join('.')
    .replaceAll('.[', '[')
  return key ? (base ? `${base}.${key}` : key) : base || 'input'
}

export function fieldErrorsFromZod(error: { issues?: unknown }): ScryerFieldError[] {
  const issues = Array.isArray(error.issues)
    ? (error.issues as { path?: unknown[]; message?: string; code?: string; keys?: string[] }[])
    : []
  return issues.flatMap((issue) => {
    if (issue.code === 'unrecognized_keys' && Array.isArray(issue.keys)) {
      return issue.keys.map((key) => ({
        path: formatZodPath(issue.path ?? [], key),
        message: issue.message ?? 'Unrecognized key',
        code: issue.code
      }))
    }
    return [
      {
        path: formatZodPath(issue.path ?? []),
        message: issue.message ?? 'Invalid value',
        ...(issue.code ? { code: issue.code } : {})
      }
    ]
  })
}

export function hasUnrecognizedKeys(error: { issues?: unknown }): boolean {
  return Array.isArray(error.issues)
    ? (error.issues as { code?: string }[]).some((issue) => issue.code === 'unrecognized_keys')
    : false
}

export function responsibilitiesFromInput(
  input: unknown,
  ids: { responsibility(): string }
): ScryResponsibility[] | undefined {
  if (!Array.isArray(input)) {
    return undefined
  }
  return input
    .map((item) =>
      typeof item === 'string'
        ? { id: ids.responsibility(), statement: item }
        : typeof item === 'object' && item !== null
          ? {
              id: ids.responsibility(),
              statement: String((item as { statement?: unknown }).statement ?? '')
            }
          : null
    )
    .filter((item): item is ScryResponsibility => Boolean(item && item.statement.trim()))
}

export function stringField(record: RecordInput, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

export function stringArrayField(record: RecordInput, key: string): string[] | undefined {
  const value = record[key]
  return Array.isArray(value) ? value.map(String) : undefined
}

export function plannedOrFailure(state: { planned?: ScryModel }, operationId: string) {
  if (!state.planned) {
    return failure('internal_error', `Planned state was not loaded for ${operationId}`, {
      reason: 'policy_violation',
      contractOperationId: operationId
    })
  }
  return null
}
