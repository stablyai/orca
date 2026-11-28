import {
  generationOptionTokens,
  type GenerationArgument
} from '../../../shared/source-control/ai/generation/generation-argument'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { prepareKimiTextTaskPolicy } from './source-control-kimi-policy'
import { z } from 'zod'
import { findOptionOccurrence } from '../../../shared/cli/command-option-occurrence'
import { KIMI_VALUE_OPTIONS } from '../../../shared/source-control/ai/generation/commit-message-generation-options'
import type { CommitMessagePlan } from '../../../shared/source-control/ai/generation/commit-message-plan'
import { isNamingOnlyTextAgent } from '../../../shared/source-control/ai/generation/commit-message-agent-spec'
import { wslDistroForCommand } from '../../../shared/file-access/wsl-paths'
import { CODEX_DISABLE_PLUGINS_ARGS } from '../../codex-cli/codex-read-only-app-server-args'
import { runWslProcess } from '../../wsl/execution/wsl-runner'
import { guestUncPath, wslGuestShellPaths } from '../../wsl/filesystem/wsl-guest-drive-path'
import { TEXT_TASK_DIRECTORY } from '../prompts/source-control-prompt-files'
import { runSourceControlPolicyProbe } from './source-control-policy-probe'
import type {
  LocalGenerationTarget,
  LocalProcessExecution,
  SpawnSourceControlAgent,
  TextGenerationOperation
} from '../source-control-text-generation-types'

const codexExclusions = [...CODEX_DISABLE_PLUGINS_ARGS, '-c', 'features.apps=false']

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
    // The workspace and a drive recipe path resolve under the distro's own drive mount.
    const { prelude, words } = wslGuestShellPaths([target.cwd, file].map(guestUncPath), 1)
    const home =
      commandEnv?.HOME ?? (target.env?.HOME !== process.env.HOME ? target.env?.HOME : undefined)
    const result = await runWslProcess({
      distro,
      loginPath: 'preferred',
      ...(home !== undefined ? { env: { ORCA_TEXT_TASK_HOME: home } } : {}),
      script: `${prelude}cd ${words[0]} || exit 1; set -- ${words[1]}; if [ "\${ORCA_TEXT_TASK_HOME+x}" ]; then HOME=$ORCA_TEXT_TASK_HOME; fi; case "$1" in "~/"*) file=$HOME/\${1#??} ;; *) file=$1 ;; esac; cat -- "$file"`,
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

function dshPolicy(
  plan: CommitMessagePlan<GenerationArgument>
): CommitMessagePlan<GenerationArgument> {
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
  plan: CommitMessagePlan<GenerationArgument>
  target: LocalGenerationTarget
  signal: AbortSignal
  spawnAgent: SpawnSourceControlAgent
  operation?: TextGenerationOperation
}): LocalProcessExecution<CommitMessagePlan<GenerationArgument>> {
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

  async function prepare(): Promise<CommitMessagePlan<GenerationArgument>> {
    const { plan, target, signal } = input
    const naming = input.operation === 'conversation-name'
    if (isNamingOnlyTextAgent(input.agentId)) {
      if (naming) {
        return plan
      }
      throw new Error('The agent cannot apply the text task tool policy')
    }
    if (input.agentId === 'kimi') {
      const selected = findOptionOccurrence(
        generationOptionTokens(plan.args),
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
