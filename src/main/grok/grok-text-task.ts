import type { InitializeResponse } from '../acp/generated/acp-protocol.generated'
import {
  resolveProviderChildEnv,
  type ProviderProcessLaunch
} from '../provider-process/provider-process-launch'
import { runLocalSourceControlPlan } from '../text-generation/execution/source-control-local-process'
import { spawnSourceControlAgent } from '../text-generation/execution/source-control-agent-launch'
import { cancelLocalGeneration } from '../text-generation/execution/source-control-generation-lanes'

export const GROK_TEXT_TASK_ENV = { GROK_STORAGE_MODE: 'local' } as const

/** Headless eager authentication must select the same advertised method as the native chat task. */
export function grokTextTaskPreservesAccount(
  initialized: InitializeResponse,
  expected: string | undefined
): boolean {
  const methods = initialized.authMethods?.map((method) => method.id) ?? []
  const declared = initialized._meta?.defaultAuthMethodId
  const selected =
    typeof declared === 'string' && methods.includes(declared)
      ? declared
      : methods.includes('cached_token')
        ? 'cached_token'
        : methods[0]
  return selected === expected
}

/** The CLI applies this tool filter after resolving model-specific harnesses and saved grants. */
export async function runGrokTextTask(input: {
  launch: ProviderProcessLaunch & { prefixArgs: string[] }
  cwd: string
  prompt: string
  sessionId: string
  signal: AbortSignal
  timeoutMs: number
}): Promise<string> {
  input.signal.throwIfAborted()
  const args = [
    ...input.launch.prefixArgs,
    '--session-id',
    input.sessionId,
    '--tools',
    'Read,Grep,Glob',
    '--disallowed-tools',
    'search_tool,use_tool,Agent',
    '--deny',
    'Bash,Edit,Write',
    '--permission-mode',
    'default',
    '--output-format',
    'plain',
    '--prompt-file',
    '{text-task-prompt}'
  ]
  const cancel = () => cancelLocalGeneration('conversation-name', input.cwd)
  const execution = runLocalSourceControlPlan({
    plan: {
      binary: input.launch.command,
      args,
      label: 'Grok',
      stdinPayload: null,
      taskFiles: [
        { name: 'text-task-prompt.txt', content: input.prompt, argIndex: args.length - 1 }
      ]
    },
    cwd: input.cwd,
    operation: 'conversation-name',
    env: { ...resolveProviderChildEnv(input.launch, process.env), ...GROK_TEXT_TASK_ENV },
    spawnAgent: spawnSourceControlAgent,
    timeoutMs: input.timeoutMs
  })
  input.signal.addEventListener('abort', cancel, { once: true })
  if (input.signal.aborted) {
    cancel()
  }
  try {
    const result = await execution.result
    input.signal.throwIfAborted()
    if (!result.success) {
      throw new Error('Grok did not complete chat naming')
    }
    return result.rawOutput
  } finally {
    input.signal.removeEventListener('abort', cancel)
    await execution.processClosed
  }
}
