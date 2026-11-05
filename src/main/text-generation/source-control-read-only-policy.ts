import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { parse as parseJson, type ParseError } from 'jsonc-parser'
import { z } from 'zod'
import { findOptionOccurrence } from '../../shared/command-option-occurrence'
import {
  compactRecipeOptions,
  KIMI_VALUE_OPTIONS
} from '../../shared/source-control/ai/generation/commit-message-generation-options'
import type { CommitMessagePlan } from '../../shared/source-control/ai/generation/commit-message-plan'
import { parseWslUncPath, wslDistroForCommand } from '../../shared/wsl-paths'
import { CODEX_DISABLE_PLUGINS_ARGS } from '../codex-cli/codex-read-only-app-server-args'
import { runWslProcess } from '../wsl/execution/wsl-runner'
import { TEXT_TASK_DIRECTORY } from './source-control-prompt-files'
import { runSourceControlPolicyProbe } from './source-control-policy-probe'
import type {
  LocalGenerationTarget,
  LocalProcessExecution,
  SpawnSourceControlAgent
} from './source-control-text-generation-types'

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

async function kimiPolicy(
  plan: CommitMessagePlan,
  target: LocalGenerationTarget,
  signal: AbortSignal
) {
  if (findOptionOccurrence(plan.args, ['--agent'], true, KIMI_VALUE_OPTIONS, 0, 'required')) {
    throw new Error('Kimi named profiles cannot apply the text task tool policy')
  }
  const file = findOptionOccurrence(
    plan.args,
    ['--agent-file'],
    true,
    KIMI_VALUE_OPTIONS,
    0,
    'required'
  )
  let content =
    '---\nname: orca-text-generation\ndescription: Text generation for Orca\ntools: []\n---\n${base_prompt}\n'
  if (file) {
    if (!file.value) {
      throw new Error('Missing text task agent file')
    }
    const original = await recipeFile(file.value, target, signal, plan.env)
    const frontmatter =
      /^(?:\uFEFF)?---[^\S\r\n]*\r?\n([\s\S]*?)\r?\n---[^\S\r\n]*(?:\r?\n|$)([\s\S]*)$/.exec(
        original
      )
    if (!frontmatter) {
      throw new Error('Invalid text task agent file')
    }
    const profile = object.parse(parseYaml(frontmatter[1]))
    if (profile.name == null || (typeof profile.name === 'string' && !profile.name.trim())) {
      profile.name = (file.value.split(/[\\/]/).pop() ?? '').replace(/\.[^.]*$/, '')
    }
    profile.tools = []
    delete profile.disallowedTools
    content = `---\n${stringifyYaml(profile)}---\n${frontmatter[2]}`
  }
  const args = compactRecipeOptions(plan.args, ['--agent-file'], KIMI_VALUE_OPTIONS)
  args.push('--agent-file', '{text-task-profile}')
  return {
    ...plan,
    args,
    taskFiles: [{ name: 'text-task-profile.md', content, argIndex: args.length - 1 }]
  }
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
    if (input.agentId === 'amp' || input.agentId === 'muse') {
      throw new Error('The agent cannot apply the text task tool policy')
    }
    if (input.agentId === 'antigravity') {
      const help = await probe([...(plan.policyProbeArgs ?? []), '--help'])
      if (![help.stdout, help.stderr].some((text) => /^\s*--settings(?:[= \t]|$)/m.test(text))) {
        throw new Error('The agent cannot apply session-only text task settings')
      }
      return antigravityPolicy(plan, target, signal)
    }
    if (input.agentId === 'kimi') {
      return kimiPolicy(plan, target, signal)
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
