import type {
  JiraCreateField,
  JiraEditField,
  JiraEditFieldValue,
  JiraSite,
  JiraUser
} from '../../shared/jira/jira-types'
import { getJiraEditFieldSchemaEditor } from '../../shared/jira/jira-edit-field-editor'
import { adfToMarkdownText } from './adf-markdown'
import { adfRoundTripsThroughMarkdown } from './adf-round-trip'
import { mapCreateField, mapCreateFieldAllowedValue, mapUser } from './jira-issue-mapping'
import { asRecord, asString, type JiraRecord } from './jira-record-pages'

const RICH_TEXT_SYSTEM_FIELDS = new Set(['description', 'environment'])
// Schema types whose values are {id, name|value} references.
const OPTION_TYPES = new Set(['option', 'version', 'component', 'priority', 'resolution'])

function isRichTextEditField(field: JiraCreateField): boolean {
  return (
    RICH_TEXT_SYSTEM_FIELDS.has(field.schema?.system ?? '') ||
    (field.schema?.custom ?? '').endsWith(':textarea')
  )
}

function isEmptyValue(raw: unknown): boolean {
  return raw === null || raw === undefined || raw === '' || (Array.isArray(raw) && raw.length === 0)
}

/** Best-effort label for values Orca shows but cannot edit (sprints, cascades, ...). */
function describeJiraFieldValue(raw: unknown): string {
  if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
    return String(raw)
  }
  if (Array.isArray(raw)) {
    return raw.map(describeJiraFieldValue).filter(Boolean).join(', ')
  }
  const record = asRecord(raw)
  const label =
    asString(record.displayName) ||
    asString(record.name) ||
    asString(record.value) ||
    asString(record.key)
  const child = record.child === undefined ? '' : describeJiraFieldValue(record.child)
  return child ? `${label} - ${child}` : label
}

function unsupported(raw: unknown): JiraEditFieldValue {
  return { kind: 'unsupported', display: describeJiraFieldValue(raw) }
}

function mapUsers(values: unknown[]): JiraUser[] {
  return values.map(mapUser).filter((user): user is JiraUser => !!user)
}

function mapEditFieldValue(field: JiraCreateField, raw: unknown): JiraEditFieldValue {
  if (isEmptyValue(raw)) {
    return { kind: 'empty' }
  }
  const { type, items } = field.schema ?? {}
  if (typeof raw === 'string' || typeof raw === 'number') {
    return { kind: 'text', text: String(raw) }
  }
  if (type === 'user') {
    const users = mapUsers([raw])
    return users.length > 0 ? { kind: 'users', users } : unsupported(raw)
  }
  if (Array.isArray(raw)) {
    if (items === 'string' && raw.every((value) => typeof value === 'string')) {
      return { kind: 'strings', values: raw }
    }
    if (items === 'user') {
      return { kind: 'users', users: mapUsers(raw) }
    }
    if (OPTION_TYPES.has(items ?? '')) {
      return { kind: 'options', options: raw.map(mapCreateFieldAllowedValue) }
    }
    return unsupported(raw)
  }
  if (OPTION_TYPES.has(type ?? '')) {
    return { kind: 'options', options: [mapCreateFieldAllowedValue(raw)] }
  }
  return unsupported(raw)
}

function richTextValue(raw: unknown): JiraEditFieldValue {
  if (isEmptyValue(raw)) {
    return { kind: 'empty' }
  }
  // Server/DC stores wiki text, which Orca edits verbatim; Cloud stores ADF.
  return { kind: 'text', text: typeof raw === 'string' ? raw : adfToMarkdownText(raw) }
}

/** Maps one editmeta entry and the issue's current value into an edit field. */
export async function mapEditField(
  site: JiraSite,
  fieldKey: string,
  meta: JiraRecord,
  raw: unknown,
  includeRaw = false
): Promise<JiraEditField | null> {
  const field = mapCreateField(meta, fieldKey)
  if (!field) {
    return null
  }
  const operations = Array.isArray(meta.operations)
    ? meta.operations.filter((operation): operation is string => typeof operation === 'string')
    : []
  // Archived versions and disabled options are still listed but Jira rejects them.
  const allowedValues = Array.isArray(meta.allowedValues)
    ? meta.allowedValues
        .filter(
          (option) => asRecord(option).disabled !== true && asRecord(option).archived !== true
        )
        .map(mapCreateFieldAllowedValue)
    : undefined
  const richText = isRichTextEditField(field)
  const value = richText ? richTextValue(raw) : mapEditFieldValue(field, raw)
  // Writable only when Orca has an editor for the schema and could read the value,
  // so an empty Sprint or cascading select still reports read-only.
  let writable =
    operations.includes('set') &&
    value.kind !== 'unsupported' &&
    getJiraEditFieldSchemaEditor({ schema: field.schema, allowedValues, richText }) !== 'readonly'
  if (writable && richText && site.authType !== 'server' && raw && typeof raw === 'object') {
    writable = await adfRoundTripsThroughMarkdown(raw)
  }
  return {
    ...field,
    allowedValues,
    operations,
    value,
    ...(richText ? { richText: true } : {}),
    writable,
    ...(includeRaw ? { rawValue: raw ?? null } : {})
  }
}
