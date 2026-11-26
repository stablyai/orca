import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { OpenCodeTextTaskSession } from './opencode-text-task-session'
import type { createOpenCodeTextTaskHttp } from './opencode-text-task-http'

const RULES = [
  ['*', '*', 'deny'],
  ['read', '*', 'allow'],
  ['grep', '*', 'allow'],
  ['glob', '*', 'allow'],
  ['external_directory', '*', 'allow'],
  ['read', 'mcp:*', 'deny']
] as const

const v1PolicyRules = z.array(
  z.object({
    permission: z.string(),
    pattern: z.string(),
    action: z.enum(['allow', 'deny', 'ask'])
  })
)

export function acknowledgesOpenCodeV1Policy(
  response: unknown,
  policy: Record<string, unknown>,
  fork: boolean
): boolean {
  const actual = z.looseObject({ permission: v1PolicyRules.optional() }).parse(response).permission
  if (!actual?.length) {
    return false
  }
  const expected = v1PolicyRules.nonempty().parse(policy.permission)
  const tail = actual.slice(-expected.length)
  if (
    (fork || actual.length === expected.length) &&
    tail.length === expected.length &&
    tail.every(
      (rule, index) =>
        rule.permission === expected[index].permission &&
        rule.pattern === expected[index].pattern &&
        rule.action === expected[index].action
    )
  ) {
    return true
  }
  throw new Error('OpenCode did not apply the requested text task policy')
}

export const OPEN_CODE_LEGACY_TEXT_TASK_TOOLS = {
  '*': false,
  read: true,
  grep: true,
  glob: true,
  external_directory: true,
  bash: false,
  edit: false,
  write: false,
  patch: false,
  apply_patch: false,
  multiedit: false,
  task: false,
  todowrite: false
} as const

export async function prepareOpenCodeTextTaskPolicy(
  input: OpenCodeTextTaskSession,
  http: ReturnType<typeof createOpenCodeTextTaskHttp>,
  activeSignal: AbortSignal
) {
  const v2 = input.version === 'v2'
  const request = http.request
  let agent = input.agent || undefined
  let actualSubtask = false
  let agents: { name: string; mode: string }[] | undefined
  if (!v2 && (agent || input.command)) {
    agents = z
      .array(z.looseObject({ name: z.string(), mode: z.string() }))
      .parse(await request('GET', '/agent', undefined, activeSignal))
    const selected = agents.find((candidate) => candidate.name === agent)
    if (agent && (!selected || selected.mode === 'subagent')) {
      agent = undefined
    }
  }
  if (!v2 && input.command) {
    const commands = z
      .array(
        z.looseObject({
          name: z.string(),
          agent: z.string().optional(),
          subtask: z.boolean().optional()
        })
      )
      .parse(await request('GET', '/command', undefined, activeSignal))
    const command = commands.find((candidate) => candidate.name === input.command)
    if (!command) {
      throw new Error('OpenCode command is unavailable')
    }
    actualSubtask =
      command.subtask === true ||
      (agents?.find((candidate) => candidate.name === (command.agent ?? agent))?.mode ===
        'subagent' &&
        command.subtask !== false)
    if (actualSubtask && input.operation !== 'conversation-name') {
      throw new Error('OpenCode subtask command cannot run as a private text task')
    }
  }
  const rules: readonly (readonly string[])[] = actualSubtask
    ? [
        ['*', '*', 'ask'],
        ...RULES.slice(1),
        ['bash', '*', 'deny'],
        ['edit', '*', 'deny'],
        ['todowrite', '*', 'deny']
      ]
    : RULES
  const policy = v2
    ? {
        permissions: rules.map(([action, resource, effect]) => ({ action, resource, effect }))
      }
    : {
        permission: rules.map(([permission, pattern, action]) => ({
          permission,
          pattern,
          action
        }))
      }
  return {
    agent,
    actualSubtask,
    policy,
    createBody: {
      title: input.title || `Orca text generation ${randomUUID()}`,
      ...(agent ? { agent } : {}),
      ...(v2 && input.model
        ? {
            model: {
              providerID: input.model.providerID,
              id: input.model.modelID,
              ...(input.variant ? { variant: input.variant } : {})
            }
          }
        : {}),
      ...policy
    }
  }
}
