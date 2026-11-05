import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import { mergeCommandEnvironment } from '../../shared/command-environment'
import type { CommitMessagePlan } from '../../shared/source-control/ai/generation/commit-message-plan'
import { killSourceControlAgentProcess } from './source-control-agent-termination'
import { MAX_SOURCE_CONTROL_AGENT_OUTPUT_BYTES } from './source-control-generation-limits'
import type {
  LocalGenerationTarget,
  SpawnSourceControlAgent
} from './source-control-text-generation-types'

/** Effective configuration may contain credentials; keep both streams private even on failure. */
export async function runSourceControlPolicyProbe(input: {
  plan: CommitMessagePlan
  args: string[]
  target: LocalGenerationTarget
  signal: AbortSignal
  spawnAgent: SpawnSourceControlAgent
}): Promise<{ stdout: string; stderr: string }> {
  input.signal.throwIfAborted()
  const child = input.spawnAgent({
    binary: input.plan.binary,
    args: input.args,
    cwd: input.target.cwd,
    wslDistro: input.target.wslDistro,
    env: input.target.wslDistro
      ? input.target.env
      : mergeCommandEnvironment(input.target.env, input.plan.env, process.platform),
    commandEnv: input.plan.env,
    stdinMode: 'pipe',
    useCwdForNative: true
  })
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
  const result = Promise.withResolvers<{ stdout: string; stderr: string }>()
  void result.promise.catch(() => {})
  let output = ''
  let errors = ''
  let bytes = 0
  const observe = (chunk: Buffer, stdout: boolean) => {
    bytes += chunk.byteLength
    if (bytes > MAX_SOURCE_CONTROL_AGENT_OUTPUT_BYTES) {
      result.reject(new Error('Text task configuration exceeds its output limit'))
    } else if (stdout) {
      output += chunk.toString('utf8')
    } else {
      errors += chunk.toString('utf8')
    }
  }
  child.stdout?.on('data', (chunk: Buffer) => observe(chunk, true))
  child.stderr?.on('data', (chunk: Buffer) => observe(chunk, false))
  child.once('error', () => result.reject(new Error('Text task configuration could not be read')))
  child.once('close', (code) => {
    if (code === 0) {
      result.resolve({ stdout: output, stderr: errors })
    } else {
      result.reject(new Error('Text task configuration could not be read'))
    }
  })
  child.stdin?.on('error', () =>
    result.reject(new Error('Text task configuration could not be read'))
  )
  child.stdin?.end()
  try {
    return await waitForPromiseWithSignal(result.promise, input.signal)
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      await killSourceControlAgentProcess(child)
    }
    await closed
  }
}
