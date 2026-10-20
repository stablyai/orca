import { runProcess } from '@orca/process-host'
import type { AgentStartupPlanInputs } from '../../shared/agent-startup-plan-inputs'
import { getTuiAgentLaunchCommand, TUI_AGENT_CONFIG } from '../../shared/tui-agent-config'
import {
  quoteStartupArg,
  resolveStartupShell,
  tokenizeStartupCommand
} from '../../shared/tui-agent-startup-shell'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { resolveCommandOnLocalPath } from '../ipc/command-path-resolver'
import { resolveLoginShellEnvironment } from '../startup/login-shell-environment'
import { OrchestrationError } from '../runtime/orchestration/orchestration-error'

function refuse(): never {
  throw new OrchestrationError(
    'capability_unsupported',
    'The execution host cannot verify DSH session model and effort options. Use a DSH-TUI with native --model/--effort support, or omit the launch overrides.'
  )
}

export async function prepareDshModelStartupInputs(options: {
  inputs: AgentStartupPlanInputs
  cwd: string
  isWsl?: boolean
  accountEnv?: Record<string, string>
  signal?: AbortSignal
}): Promise<AgentStartupPlanInputs> {
  const { inputs } = options
  if (
    inputs.agent !== 'dsh' ||
    !Object.values(inputs.sessionOptions ?? {}).some((value) => value !== undefined)
  ) {
    return inputs
  }
  const { model, effort, ...unsupported } = inputs.sessionOptions ?? {}
  if (
    typeof model !== 'string' ||
    !model.trim() ||
    (effort !== undefined && (typeof effort !== 'string' || !effort.trim())) ||
    Object.values(unsupported).some((value) => value !== undefined)
  ) {
    throw new OrchestrationError(
      'invalid_argument',
      'DSH launch options require a model and an optional effort string.'
    )
  }
  if (
    inputs.isRemote ||
    options.isWsl ||
    parseWslUncPath(options.cwd) ||
    inputs.platform !== process.platform ||
    options.signal?.aborted
  ) {
    refuse()
  }
  const shell = resolveStartupShell(inputs.platform, inputs.shell)
  const command =
    inputs.cmdOverrides.dsh || getTuiAgentLaunchCommand(TUI_AGENT_CONFIG.dsh, inputs.platform)
  const parsed = tokenizeStartupCommand(command, shell)
  if (
    !parsed.ok ||
    !parsed.tokens.length ||
    parsed.spans.some((span) => span.divergesFromShell) ||
    (parsed.tokens.length > 1 && !(parsed.tokens.length === 2 && parsed.tokens[1] === '.'))
  ) {
    refuse()
  }
  const env = {
    ...process.env,
    ...(await resolveLoginShellEnvironment()),
    ...inputs.agentEnv,
    ...options.accountEnv
  }
  const executable = await resolveCommandOnLocalPath(parsed.tokens[0], { env, cwd: options.cwd })
  if (!executable) {
    refuse()
  }
  try {
    const result = await runProcess({
      program: executable,
      args: ['--help'],
      env,
      cwd: options.cwd,
      timeoutMs: 5_000,
      maxOutputBytes: 65_536,
      signal: options.signal
    })
    const flags = result.stdout
    if (
      result.code !== 0 ||
      result.timedOut ||
      result.outputTruncated ||
      !/^\s*--model\s+</m.test(flags) ||
      !/^\s*--effort\s+</m.test(flags)
    ) {
      refuse()
    }
  } catch {
    refuse()
  }
  // Pin the verified executable so a login shell cannot select an older CLI from another PATH.
  return {
    ...inputs,
    cmdOverrides: {
      ...inputs.cmdOverrides,
      dsh: [executable, ...parsed.tokens.slice(1)]
        .map((token) => quoteStartupArg(token, shell))
        .join(' ')
    }
  }
}
