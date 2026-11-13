import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { prepareKimiTextTaskPolicy } from './source-control-kimi-policy'
import { parse as parseJson, type ParseError } from 'jsonc-parser'
import { z } from 'zod'
import { findOptionOccurrence } from '../../../shared/command-option-occurrence'
import {
  compactRecipeOptions,
  KIMI_VALUE_OPTIONS
} from '../../../shared/source-control/ai/generation/commit-message-generation-options'
import type { CommitMessagePlan } from '../../../shared/source-control/ai/generation/commit-message-plan'
import { museReadOnlyRecipeArgs } from '../../../shared/source-control/ai/generation/commit-message-recipe-options'
import { parseWslUncPath, wslDistroForCommand } from '../../../shared/wsl-paths'
import { CODEX_DISABLE_PLUGINS_ARGS } from '../../codex-cli/codex-read-only-app-server-args'
import { runWslProcess } from '../../wsl/execution/wsl-runner'
import { TEXT_TASK_DIRECTORY } from '../prompts/source-control-prompt-files'
import { runSourceControlPolicyProbe } from './source-control-policy-probe'
import type {
  LocalGenerationTarget,
  LocalProcessExecution,
  SpawnSourceControlAgent,
  TextGenerationOperation
} from '../source-control-text-generation-types'

const object = z.record(z.string(), z.unknown())
const strings = z.array(z.string())
const settingsOptions = [
  '--settings',
  '--model',
  '--effort',
  '--agent',
  '--input-format',
  '--output-format'
]
const codexExclusions = [...CODEX_DISABLE_PLUGINS_ARGS, '-c', 'features.apps=false']
const AG_DENIES = ['write_file(*)', 'command(*)', 'mcp(*)', 'read_url(*)', 'execute_url(*)']

async function recipeFile(
  file: string,
  target: LocalGenerationTarget,
  signal: AbortSignal,
  commandEnv?: Record<string, string>
): Promise<string> {
  signal.throwIfAborted()
  const distro =
    process.platform === 'win32' ? wslDistroForCommand(target.cwd, target.wslDistro) : null
  if (distro) {
    const cwd = parseWslUncPath(target.cwd)?.linuxPath ?? target.cwd
    const home =
      commandEnv?.HOME ?? (target.env?.HOME !== process.env.HOME ? target.env?.HOME : undefined)
    const result = await runWslProcess({
      distro,
      cwd,
      loginPath: 'preferred',
      ...(home !== undefined ? { env: { ORCA_TEXT_TASK_HOME: home } } : {}),
      script:
        'if [ "${ORCA_TEXT_TASK_HOME+x}" ]; then HOME=$ORCA_TEXT_TASK_HOME; fi; case "$1" in "~/"*) file=$HOME/${1#??} ;; *) file=$1 ;; esac; cat -- "$file"',
      args: [file],
      timeoutMs: 10_000,
      maxOutputBytes: 1024 * 1024
    })
    signal.throwIfAborted()
    if (result.code !== 0 || result.timedOut || result.outputTruncated) {
      throw new Error('Text task recipe file could not be read')
    }
    return result.stdout
  }
  const home =
    process.platform === 'win32'
      ? (target.env?.USERPROFILE ?? homedir())
      : (target.env?.HOME ?? homedir())
  const expanded = file.startsWith('~/') ? path.join(home, file.slice(2)) : file
  const content = await readFile(path.resolve(target.cwd, expanded), 'utf8')
  signal.throwIfAborted()
  return content
}

function jsonObject(text: string): Record<string, unknown> {
  const errors: ParseError[] = []
  const value: unknown = parseJson(text.replace(/^\uFEFF/, ''), errors, {
    allowTrailingComma: true
  })
  if (errors.length) {
    throw new Error('Invalid text task settings')
  }
  return object.parse(value)
}

async function antigravityPolicy(
  plan: CommitMessagePlan,
  target: LocalGenerationTarget,
  signal: AbortSignal
) {
  let settings: Record<string, unknown> = {}
  let cursor = 0
  for (;;) {
    const option = findOptionOccurrence(
      plan.args,
      ['--settings'],
      true,
      settingsOptions,
      cursor,
      'required'
    )
    if (!option) {
      break
    }
    if (!option.value) {
      throw new Error('Missing text task settings')
    }
    const next = jsonObject(
      option.value.trimStart().startsWith('{')
        ? option.value
        : await recipeFile(option.value, target, signal, plan.env)
    )
    const previousPermissions = object.parse(settings.permissions ?? {})
    const nextPermissions = object.parse(next.permissions ?? {})
    settings = {
      ...settings,
      ...next,
      permissions: {
        ...previousPermissions,
        ...nextPermissions,
        ...Object.fromEntries(
          ['allow', 'ask', 'deny'].map((key) => [
            key,
            [
              ...new Set([
                ...strings.parse(previousPermissions[key] ?? []),
                ...strings.parse(nextPermissions[key] ?? [])
              ])
            ]
          ])
        )
      }
    }
    cursor = option.index + option.consumed
  }
  const permissions = object.parse(settings.permissions ?? {})
  const allow = strings.parse(permissions.allow ?? [])
  const deny = strings.parse(permissions.deny ?? [])
  const composed = {
    ...settings,
    toolPermission: 'request-review',
    allowNonWorkspaceAccess: true,
    permissions: {
      ...permissions,
      allow: [...new Set([...allow, 'read_file(*)'])],
      deny: [...new Set([...deny, ...AG_DENIES])]
    }
  }
  return {
    ...plan,
    args: [
      ...compactRecipeOptions(plan.args, ['--settings'], settingsOptions),
      '--settings',
      JSON.stringify(composed)
    ]
  }
}

function musePolicy(plan: CommitMessagePlan): CommitMessagePlan {
  // A command override wrapper owns the leading args (and possibly its own `--`); force flags only inside the Muse segment.
  const prefix = plan.args.slice(0, plan.commandPrefixArgCount ?? 0)
  const segment = plan.args.slice(prefix.length)
  const terminator = segment.indexOf('--')
  const head = terminator === -1 ? segment.slice(0, -1) : segment.slice(0, terminator)
  const tail = terminator === -1 ? segment.slice(-1) : segment.slice(terminator)
  const args = museReadOnlyRecipeArgs(head)
  for (const flag of ['--disable-shell', '--disable-write', '--disable-web-tools']) {
    if (!args.includes(flag)) {
      args.push(flag)
    }
  }
  // Muse rejects a repeated --approval-mode, so the stripped head gets exactly one forced pair.
  args.push('--approval-mode', 'on-request', '--approval-judge', 'off')
  return { ...plan, args: [...prefix, ...args, ...tail] }
}

function dshPolicy(plan: CommitMessagePlan): CommitMessagePlan {
  const plugin = `export const inject = ['tools']\nexport function apply(ctx) {\n  ctx.tools.guard(exec => exec.name === 'read' ? undefined : 'This text task permits only file reads')\n  ctx.provide('orcaTextReadPolicy', Object.freeze({}))\n}\n`
  const patch = JSON.stringify([
    { id: 'tools', config: { mode: 'native' } },
    {
      insert: [{ id: 'orca-text-read-policy', name: `${TEXT_TASK_DIRECTORY}/text-task-policy.mjs` }]
    },
    { id: 'headless-runner', inject: ['headlessStartup', 'orcaTextReadPolicy'] }
  ])
  // Launcher overlays must precede its task operand and follow the user's overlays.
  const args = [...plan.args]
  const task = args.indexOf('-')
  args.splice(task === -1 ? args.length : task, 0, '--patch', '{text-task-policy}')
  return {
    ...plan,
    args,
    taskFiles: [
      { name: 'text-task-policy.mjs', content: plugin },
      {
        name: 'text-task-policy.json',
        content: patch,
        interpolateDirectory: true,
        argIndex: task === -1 ? args.length - 1 : task + 1
      }
    ]
  }
}

export function prepareSourceControlReadOnlyPlan(input: {
  agentId: string
  plan: CommitMessagePlan
  target: LocalGenerationTarget
  signal: AbortSignal
  spawnAgent: SpawnSourceControlAgent
  operation?: TextGenerationOperation
}): LocalProcessExecution<CommitMessagePlan> {
  let probeClosed = Promise.resolve()
  const probe = async (args: string[]) => {
    const execution = runSourceControlPolicyProbe({ ...input, args })
    probeClosed = execution.processClosed
    const output = await execution.result
    await execution.processClosed
    input.signal.throwIfAborted()
    return output
  }
  const result = prepare()
  return {
    result,
    processClosed: result.then(
      () => probeClosed,
      () => probeClosed
    )
  }

  async function prepare(): Promise<CommitMessagePlan> {
    const { plan, target, signal } = input
    const naming = input.operation === 'conversation-name'
    if (input.agentId === 'muse') {
      return musePolicy(plan)
    }
    if (input.agentId === 'amp') {
      if (naming) {
        return plan
      }
      throw new Error('The agent cannot apply the text task tool policy')
    }
    if (input.agentId === 'antigravity') {
      const help = await probe([...(plan.policyProbeArgs ?? []), '--help'])
      if (![help.stdout, help.stderr].some((text) => /^\s*--settings(?:[= \t]|$)/m.test(text))) {
        if (naming) {
          return plan
        }
        throw new Error('The agent cannot apply session-only text task settings')
      }
      return antigravityPolicy(plan, target, signal)
    }
    if (input.agentId === 'kimi') {
      const selected = findOptionOccurrence(
        plan.args,
        ['--agent', '--session', '-S', '--resume', '-r', '--continue', '-c', '-C'],
        true,
        [...KIMI_VALUE_OPTIONS, '--session', '-S', '--resume', '-r'],
        0,
        false
      )
      if (selected) {
        if (naming) {
          return plan
        }
        throw new Error('Kimi selected history/profile cannot apply the text task tool policy')
      }
      return prepareKimiTextTaskPolicy(plan, (file) => recipeFile(file, target, signal, plan.env))
    }
    if (input.agentId === 'dsh') {
      return dshPolicy(plan)
    }
    if (input.agentId !== 'codex') {
      return plan
    }
    const raw = await probe([
      ...(plan.policyProbeArgs ?? []),
      ...codexExclusions,
      'mcp',
      'list',
      '--json'
    ])
    const servers = z.array(z.looseObject({ name: z.string() })).parse(JSON.parse(raw.stdout))
    const entries = servers.map((server) => `${JSON.stringify(server.name)}={enabled=false}`)
    return {
      ...plan,
      args: [...plan.args, ...codexExclusions, '-c', `mcp_servers={${entries.join(',')}}`]
    }
  }
}
