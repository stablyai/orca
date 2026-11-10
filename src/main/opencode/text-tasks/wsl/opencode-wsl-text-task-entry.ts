import { z } from 'zod'
import { SearchSubprocessLineAccumulator } from '../../../../shared/search-subprocess-lines'
import { killSourceControlAgentProcess } from '../../../text-generation/execution/source-control-agent-termination'
import { spawnSupervisedAgent } from '../../../text-generation/execution/source-control-supervised-agent-spawn'
import {
  OPENCODE_WSL_TEXT_TASK_CLEANUP_MS,
  OPENCODE_WSL_TEXT_TASK_REQUEST_MAX_BYTES,
  type OpenCodeWslTextTaskResult
} from './opencode-wsl-text-task-protocol'
import { OpenCodeTextTaskError, runOwnedOpenCodeTextTask } from '../opencode-owned-text-task'
import { guestLoginShellLaunch } from './opencode-wsl-guest-launch'

const request = z.object({
  nonce: z.string().regex(/^[0-9a-f]{32}$/),
  binary: z.string().min(1),
  prefixArgs: z.array(z.string()),
  prompt: z.string(),
  runArgs: z.array(z.string()),
  /** Inline command assignments; applied after the inner login rc, as the CLI route did. */
  commandEnv: z.record(z.string(), z.string()).optional(),
  legacyVariantFlag: z.boolean().optional(),
  operation: z
    .enum([
      'commit-message',
      'pull-request-fields',
      'branch-name',
      'jira-issue-summary',
      'conversation-name',
      'dictation-cleanup',
    ])
    .optional(),
  timeoutMs: z.number().int().positive()
})

// The launcher unset NODE_OPTIONS for this Node; OpenCode's own login shell sets it up again.
const env: NodeJS.ProcessEnv = { ...process.env }

// The launcher's stdin EOF, including Orca's death, cancels the task.
const launcher = new AbortController()
let started = false
const lines = new SearchSubprocessLineAccumulator(OPENCODE_WSL_TEXT_TASK_REQUEST_MAX_BYTES)
process.stdin.on('data', (chunk: Buffer) => {
  if (started) {
    return
  }
  if (!lines.push(chunk, (line) => void start(line))) {
    process.exit(1)
  }
})
process.stdin.on('end', () => launcher.abort())
process.stdin.on('error', () => launcher.abort())
process.stdout.on('error', () => launcher.abort())

async function start(line: string): Promise<void> {
  if (started) {
    return
  }
  started = true
  const task = request.parse(JSON.parse(line))
  // Backstop for a wedged cleanup: exiting lets the provider supervisor see its owner gone.
  setTimeout(() => process.exit(124), task.timeoutMs + OPENCODE_WSL_TEXT_TASK_CLEANUP_MS).unref()
  let readVersionStdout: ((stdout: string) => string | null) | undefined
  let result: OpenCodeWslTextTaskResult
  try {
    const text = await runOwnedOpenCodeTextTask({
      binary: task.binary,
      prefixArgs: task.prefixArgs,
      // The launcher's login shell entered the workspace; this is the real guest directory.
      cwd: process.cwd(),
      env,
      prompt: task.prompt,
      runArgs: task.runArgs,
      legacyVariantFlag: task.legacyVariantFlag,
      operation: task.operation,
      signal: AbortSignal.any([launcher.signal, AbortSignal.timeout(task.timeoutMs)]),
      readVersionStdout: (stdout) => readVersionStdout?.(stdout) ?? null,
      spawn: (input, context) => {
        const launch = guestLoginShellLaunch(
          input,
          env,
          task.commandEnv ?? {},
          context?.privateEnv,
          context?.captureVersion
        )
        if (context?.captureVersion) {
          readVersionStdout = launch.readStdout
        }
        return spawnSupervisedAgent(launch, launch.env)
      },
      stop: (child) => killSourceControlAgentProcess(child)
    })
    result = { ok: true, text }
  } catch (error) {
    result = {
      ok: false,
      stage: error instanceof OpenCodeTextTaskError ? error.stage : 'aborted'
    }
  }
  process.stdout.write(`${task.nonce}${JSON.stringify(result)}\n`, () => process.exit(0))
}
