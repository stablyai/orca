import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { runProcess } from '../../shared/child-process/run-process'
import { withCliRuntimeOnPath } from '../../shared/node-cli-command-resolution'
import { resolveCodexCommand } from '../codex-cli/command'
import {
  resolveCodexHomeProcessLockKey,
  withCodexHomeProcessLock
} from '../codex-cli/codex-home-process-lock'
import { openCodexAppServerConnection } from '../codex/codex-app-server-connection'
import { readCodexStructuredSessionOptionCatalog } from '../codex/codex-structured-model-catalog'
import { buildWslCodexCommand } from '../rate-limits/codex-fetcher'
import { selectCodexWarmupModel } from './codex-automation-policy'

const DISABLED_FEATURES = [
  'shell_tool',
  'unified_exec',
  'apps',
  'plugins',
  'hooks',
  'multi_agent',
  'multi_agent_v2',
  'browser_use',
  'computer_use',
  'image_generation',
  'code_mode',
  'code_mode_host',
  'skill_search',
  'memory_tool',
  'goals'
]
const ISOLATION_ARGS = [
  '-c',
  'model_provider="openai"',
  '-c',
  'project_doc_max_bytes=0',
  '-c',
  'web_search="disabled"',
  '-c',
  'mcp_servers={}',
  ...DISABLED_FEATURES.flatMap((feature) => ['-c', `features.${feature}=false`])
]
const eventSchema = z.object({
  type: z.string(),
  item: z.object({ type: z.string(), text: z.string().optional() }).optional()
})

export function completedCodexWarmup(stdout: string): boolean {
  let completed = false
  let reply = ''
  for (const line of stdout.split('\n').filter(Boolean)) {
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      return false
    }
    const parsed = eventSchema.safeParse(raw)
    if (!parsed.success) {
      return false
    }
    const event = parsed.data
    if (event.type === 'turn.failed' || event.type === 'error') {
      return false
    }
    if (event.type === 'turn.completed') {
      completed = true
    }
    if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
      reply += event.item.text ?? ''
    }
    if (event.item && !['agent_message', 'reasoning', 'error'].includes(event.item.type)) {
      return false
    }
  }
  return completed && reply.trim() === 'OK'
}

export async function warmCodexAccount(input: {
  home: string
  stateDirectory: string
  signal: AbortSignal
  beforeSubmit: () => Promise<void>
}): Promise<boolean> {
  return withCodexHomeProcessLock(resolveCodexHomeProcessLockKey(input.home), async () => {
    const cwd = join(input.stateDirectory, 'codex-warmup-empty')
    await mkdir(cwd, { recursive: true })
    const command = resolveCodexCommand()
    const env: NodeJS.ProcessEnv = withCliRuntimeOnPath(command, {
      ...process.env,
      CODEX_HOME: input.home
    })
    for (const key of [
      'OPENAI_API_KEY',
      'CODEX_API_KEY',
      'OPENAI_BASE_URL',
      'CODEX_ACCESS_TOKEN'
    ]) {
      delete env[key]
    }
    const catalogArgs = [...ISOLATION_ARGS, 'app-server']
    const wslCatalog = buildWslCodexCommand(input.home, catalogArgs, true)
    if (wslCatalog) {
      delete env.CODEX_HOME
    }
    if (input.signal.aborted) {
      return false
    }
    const connection = await openCodexAppServerConnection({
      signal: input.signal,
      command: wslCatalog?.command ?? command,
      args: wslCatalog?.args ?? catalogArgs,
      cwd,
      env: Object.fromEntries(
        Object.entries(env).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string'
        )
      ),
      envToDelete: ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'CODEX_ACCESS_TOKEN']
    })
    let selected: ReturnType<typeof selectCodexWarmupModel>
    let discoveryStopped = false
    try {
      if (input.signal.aborted) {
        return false
      }
      const catalog = await readCodexStructuredSessionOptionCatalog({ connection, current: {} })
      selected = selectCodexWarmupModel(catalog.result.models)
    } finally {
      discoveryStopped = await connection.close()
    }
    if (!discoveryStopped) {
      throw new Error('Warmup discovery could not stop')
    }
    if (!selected || input.signal.aborted) {
      return false
    }
    const args = [
      'exec',
      '--ignore-user-config',
      '--ignore-rules',
      '--ephemeral',
      '--skip-git-repo-check',
      '--sandbox',
      'read-only',
      '--model',
      selected.model,
      '--json',
      '-c',
      'approval_policy="never"',
      '-c',
      `model_reasoning_effort="${selected.effort}"`,
      ...ISOLATION_ARGS,
      'Reply with exactly OK.'
    ]
    const wsl = buildWslCodexCommand(input.home, args, true)
    await input.beforeSubmit()
    if (input.signal.aborted) {
      return false
    }
    const result = await runProcess({
      program: wsl?.command ?? command,
      args: wsl?.args ?? args,
      cwd,
      env,
      signal: input.signal,
      timeoutMs: 90_000,
      maxOutputBytes: 1_000_000,
      terminationBarrier: true
    })
    return (
      result.code === 0 &&
      !result.timedOut &&
      !result.outputTruncated &&
      completedCodexWarmup(result.stdout)
    )
  })
}
