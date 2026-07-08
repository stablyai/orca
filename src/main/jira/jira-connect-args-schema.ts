import { z } from 'zod'
import type { JiraConnectArgs } from '../../shared/types'

export type JiraConnectArgsParseResult =
  | { ok: true; value: JiraConnectArgs }
  | { ok: false; error: string }

function requiredTrimmedString(message: string) {
  return z
    .unknown()
    .transform((value) => (typeof value === 'string' ? value.trim() : ''))
    .pipe(z.string().min(1, message))
}

export const JiraCloudConnectArgsSchema = z
  .strictObject({
    deploymentType: z.literal('cloud').optional(),
    siteUrl: requiredTrimmedString('Site URL is required.'),
    email: requiredTrimmedString('Email is required.'),
    apiToken: requiredTrimmedString('API token is required.')
  })
  .transform((value) => ({ ...value, deploymentType: 'cloud' as const }))

export const JiraServerBasicConnectArgsSchema = z.strictObject({
  deploymentType: z.literal('server'),
  authMode: z.literal('basic'),
  siteUrl: requiredTrimmedString('Site URL is required.'),
  username: requiredTrimmedString('Username is required.'),
  passwordOrToken: requiredTrimmedString('Password or token is required.')
})

export const JiraServerBearerConnectArgsSchema = z.strictObject({
  deploymentType: z.literal('server'),
  authMode: z.literal('bearer'),
  siteUrl: requiredTrimmedString('Site URL is required.'),
  bearerToken: requiredTrimmedString('Bearer token is required.')
})

export const JiraConnectArgsSchema = z.union([
  JiraServerBasicConnectArgsSchema,
  JiraServerBearerConnectArgsSchema,
  JiraCloudConnectArgsSchema
])

function firstZodErrorMessage(error: z.ZodError): string {
  const issue = error.issues[0]
  if (!issue) {
    return 'Invalid Jira connection settings.'
  }
  if (issue.code === 'unrecognized_keys') {
    return `Invalid key in Jira connection settings: ${issue.keys.join(', ')}.`
  }
  return issue.message
}

export function parseJiraConnectArgs(value: unknown): JiraConnectArgsParseResult {
  if (!value || typeof value !== 'object') {
    return { ok: false, error: 'Jira connection settings are required.' }
  }
  const input = value as Record<string, unknown>
  // Why: older renderer/runtime callers omitted deploymentType before Server/DC support.
  const deploymentType = input.deploymentType ?? 'cloud'
  if (deploymentType === 'cloud') {
    const parsed = JiraCloudConnectArgsSchema.safeParse(input)
    return parsed.success
      ? { ok: true, value: parsed.data }
      : { ok: false, error: firstZodErrorMessage(parsed.error) }
  }
  if (deploymentType !== 'server') {
    return { ok: false, error: 'Jira deployment type must be Cloud or Server/Data Center.' }
  }
  if (input.authMode === 'basic') {
    const parsed = JiraServerBasicConnectArgsSchema.safeParse(input)
    return parsed.success
      ? { ok: true, value: parsed.data }
      : { ok: false, error: firstZodErrorMessage(parsed.error) }
  }
  if (input.authMode === 'bearer') {
    const parsed = JiraServerBearerConnectArgsSchema.safeParse(input)
    return parsed.success
      ? { ok: true, value: parsed.data }
      : { ok: false, error: firstZodErrorMessage(parsed.error) }
  }
  return { ok: false, error: 'Jira Server auth mode must be Basic or Bearer.' }
}
