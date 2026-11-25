import { planAgentBinary } from '../../../shared/agent-launch/startup/agent-command-plan'
import { tokenizeCustomCommandTemplate } from '../../../shared/source-control/ai/generation/commit-message-prompt'
import { mergeCommandEnvironment } from '../../../shared/shell/launch/command-environment'
import type { AgentModelProbeSpec } from '../../../shared/agent-session/options/model-catalog/agent-model-probe-spec'
import { discoverDimaModels } from './dima-model-list-discovery'
import type { DiscoverModelsLocalInput } from './commit-message-model-discovery'
import type {
  DiscoverCommitMessageModelsResult,
  SourceControlAgentSpawnInput,
  SpawnSourceControlAgent
} from '../source-control-text-generation-types'
import { killSourceControlAgentProcess } from '../execution/source-control-agent-termination'

/** Let dima's read-only runtime list start its usual daemon under its own startup lock. */
async function startDimaForModelListing(
  spawnAgent: SpawnSourceControlAgent,
  command: SourceControlAgentSpawnInput,
  signal: AbortSignal
): Promise<boolean> {
  if (signal.aborted) {
    return false
  }
  const child = spawnAgent(command)
  child.stdout?.resume()
  child.stderr?.resume()
  return new Promise((resolve) => {
    const finish = (started: boolean): void => {
      signal.removeEventListener('abort', abort)
      resolve(started)
    }
    const abort = (): void => {
      void killSourceControlAgentProcess(child).catch(() => {})
      finish(false)
    }
    child.once('error', () => finish(false))
    child.once('close', (code) => finish(code === 0))
    signal.addEventListener('abort', abort, { once: true })
  })
}

export async function discoverDimaModelsOnHost(
  spec: AgentModelProbeSpec,
  input: DiscoverModelsLocalInput
): Promise<DiscoverCommitMessageModelsResult> {
  const command = planAgentBinary(spec.binary, input.agentCommandOverride, input.backslash)
  if (!command.ok) {
    return { success: false, error: command.error }
  }
  const defaults = tokenizeCustomCommandTemplate(input.options.dimaArgs ?? '', input.backslash)
  if (!defaults.ok) {
    return { success: false, error: defaults.error }
  }
  // Only profile flags belong to this read. A launch prompt or session argument would do work.
  const profileArgs: string[] = []
  for (let index = 0; index < defaults.tokens.length; index += 1) {
    const flag = defaults.tokens[index]
    if (flag === '--') {
      break
    }
    if ((flag === '--home' || flag === '--model-config') && defaults.tokens[index + 1]) {
      profileArgs.push(flag, defaults.tokens[++index])
    }
  }
  const args = [...command.prefixArgs, ...profileArgs]
  const env = mergeCommandEnvironment(
    mergeCommandEnvironment(input.env, input.options.dimaEnv, process.platform),
    command.env,
    process.platform
  )
  const homeIndex = args.lastIndexOf('--home')
  return discoverDimaModels(spec, {
    ...input.options,
    env,
    productHome: homeIndex !== -1 ? args[homeIndex + 1] : undefined,
    startDaemon: (signal) =>
      startDimaForModelListing(
        input.spawnAgent,
        {
          binary: input.binary ?? command.binary,
          args: [...args, 'runtime', 'list'],
          cwd: input.options.cwd,
          env,
          stdinMode: 'ignore',
          useCwdForNative: true
        },
        signal
      )
  })
}
