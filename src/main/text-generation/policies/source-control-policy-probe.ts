import { providerSpawnAbsenceKnown } from '../../provider-process/provider-child'
import { abortSignalReason } from '../../../shared/abort-signal-reason'
import { mergeCommandEnvironment } from '../../../shared/command-environment'
import type { CommitMessagePlan } from '../../../shared/source-control/ai/generation/commit-message-plan'
import { killSourceControlAgentProcess } from '../execution/source-control-agent-termination'
import { MAX_SOURCE_CONTROL_AGENT_OUTPUT_BYTES } from '../execution/source-control-generation-limits'
import type {
  LocalGenerationTarget,
  LocalProcessExecution,
  SpawnSourceControlAgent
} from '../source-control-text-generation-types'

/** Effective configuration may contain credentials; keep both streams private even on failure. */
export function runSourceControlPolicyProbe(input: {
  plan: CommitMessagePlan
  args: string[]
  target: LocalGenerationTarget
  signal: AbortSignal
  spawnAgent: SpawnSourceControlAgent
}): LocalProcessExecution<{ stdout: string; stderr: string }> {
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
  const owner = Promise.withResolvers<void>()
  const result = Promise.withResolvers<{ stdout: string; stderr: string }>()
  let output = ''
  let errors = ''
  let bytes = 0
  let settled = false
  let terminal = false
  let termination: Promise<void> | undefined
  const markClosed = () => {
    if (terminal && settled) {
      void (termination ?? Promise.resolve()).then(owner.resolve)
    }
  }
  const stop = () => {
    if (terminal || child.exitCode != null || child.signalCode != null) {
      return
    }
    termination ??= killSourceControlAgentProcess(child).catch(() => {
      console.error('[text-generation] Configuration probe termination failed')
    })
  }
  const finish = (error?: Error) => {
    if (settled) {
      return
    }
    settled = true
    input.signal.removeEventListener('abort', abort)
    child.stdout?.off?.('data', stdout)
    child.stderr?.off?.('data', stderr)
    if (error) {
      result.reject(error)
    } else {
      result.resolve({ stdout: output, stderr: errors })
    }
    markClosed()
  }
  const fail = (error: Error) => {
    if (!settled) {
      stop()
      finish(error)
    }
  }
  const abort = () => fail(abortSignalReason(input.signal))
  const observe = (chunk: Buffer, isStdout: boolean) => {
    bytes += chunk.byteLength
    if (bytes > MAX_SOURCE_CONTROL_AGENT_OUTPUT_BYTES) {
      fail(new Error('Text task configuration exceeds its output limit'))
    } else if (isStdout) {
      output += chunk.toString('utf8')
    } else {
      errors += chunk.toString('utf8')
    }
  }
  const stdout = (chunk: Buffer) => observe(chunk, true)
  const stderr = (chunk: Buffer) => observe(chunk, false)
  child.stdout?.on('data', stdout)
  child.stderr?.on('data', stderr)
  child.on('error', () => {
    if (providerSpawnAbsenceKnown(child)) {
      terminal = true
    }
    fail(new Error('Text task configuration could not be read'))
  })
  child.once('exit', () => {
    terminal = true
    markClosed()
  })
  child.once('close', (code) => {
    terminal = true
    if (code === 0) {
      finish()
    } else {
      finish(new Error('Text task configuration could not be read'))
    }
    markClosed()
  })
  child.stdin?.on('error', () => fail(new Error('Text task configuration could not be read')))
  input.signal.addEventListener('abort', abort, { once: true })
  if (input.signal.aborted) {
    abort()
  } else {
    try {
      child.stdin?.end()
    } catch {
      fail(new Error('Text task configuration could not be read'))
    }
  }
  return { result: result.promise, processClosed: owner.promise }
}
