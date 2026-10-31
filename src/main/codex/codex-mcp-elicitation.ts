import { z } from 'zod'
import { MAX_JOURNAL_PROMPT_OPTIONS } from '../native-chat/agent-session-journal/journal-prompt-body-bounds'
import { readRecord } from './codex-item-field-readers'
import {
  CODEX_PROMPT_MAX_QUESTIONS,
  CODEX_PROMPT_MAX_QUESTION_BYTES
} from './codex-prompt-registry-bounds'
import {
  AgentSessionFormObjectSchema,
  agentSessionFormChoices,
  validateAgentSessionFormField,
  type AgentSessionFormField
} from '../../shared/agent-session-form'
const urlSchema = z.url({ protocol: /^https?$/ }).max(8192)
export type CodexMcpFormField = AgentSessionFormField
export type CodexMcpElicitation =
  | { kind: 'url'; message: string; url: string }
  | { kind: 'form'; message: string; fields: AgentSessionFormField[] }

/** Validate the whole form before exposing any field; partial schemas cannot be answered safely. */
export function readCodexMcpElicitation(params: unknown): CodexMcpElicitation | null {
  const record = readRecord(params)
  const message = typeof record.message === 'string' ? record.message : 'Codex needs information'
  if (Buffer.byteLength(message, 'utf8') > 8192) {
    return null
  }
  if (record.mode === 'url') {
    const url = urlSchema.safeParse(record.url)
    return url.success &&
      typeof record.elicitationId === 'string' &&
      record.elicitationId.length > 0
      ? { kind: 'url', message, url: url.data }
      : null
  }
  if (record.mode !== 'form') {
    return null
  }
  const parsed = AgentSessionFormObjectSchema.safeParse(record.requestedSchema)
  if (!parsed.success) {
    return null
  }
  const required = parsed.data.required ?? []
  if (required.some((name) => !Object.hasOwn(parsed.data.properties, name))) {
    return null
  }
  const fields = Object.entries(parsed.data.properties).map(([name, schema]) => ({
    name,
    schema,
    required: required.includes(name)
  }))
  const result: CodexMcpElicitation = { kind: 'form', message, fields }
  if (
    fields.length > CODEX_PROMPT_MAX_QUESTIONS ||
    Buffer.byteLength(JSON.stringify(result), 'utf8') > CODEX_PROMPT_MAX_QUESTION_BYTES
  ) {
    return null
  }
  try {
    for (const field of fields) {
      const schema = field.schema
      const choices = agentSessionFormChoices(field)
      if (
        !field.name ||
        field.name === '__proto__' ||
        Buffer.byteLength(field.name, 'utf8') > 256 ||
        choices.length + 2 > MAX_JOURNAL_PROMPT_OPTIONS ||
        choices.some((choice) => Buffer.byteLength(choice.label, 'utf8') > 1024) ||
        new Set(choices.map((choice) => choice.value)).size !== choices.length ||
        ('enumNames' in schema && schema.enumNames && schema.enumNames.length !== choices.length) ||
        ('minimum' in schema &&
          schema.minimum !== undefined &&
          schema.maximum !== undefined &&
          schema.minimum > schema.maximum) ||
        ('minLength' in schema &&
          schema.minLength !== undefined &&
          schema.maxLength !== undefined &&
          schema.minLength > schema.maxLength)
      ) {
        return null
      }
      if (schema.default !== undefined) {
        validateAgentSessionFormField(field, schema.default)
      }
    }
  } catch {
    return null
  }
  return result
}
