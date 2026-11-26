import { runProcess } from '@orca/process-host'
import type { ProcessResult } from '@orca/process-host/process-spec'
import {
  resolveAntigravityHostProgram,
  type AntigravityHostProgramOptions
} from './antigravity-usage-host-program'
import {
  resolveConfiguredOrSystemProxyEnv,
  shouldRetryDirectAfterSystemProxyFailure
} from '../../../network/configured-proxy-child-env'
import { hostShellEnvironment } from '../../../runtime/agent-session/environment/structured-agent-shell-environment'
import type { UsageRateLimitFailureKind } from '../../../../shared/agent-usage/rate-limits/rate-limit-types'
import type { NetworkProxySettings } from '../../../../shared/network/network-proxy'
import {
  ANTIGRAVITY_PROBE_ENV,
  ANTIGRAVITY_PROXY_PROBE_URL,
  ANTIGRAVITY_USAGE_ARGS,
  ANTIGRAVITY_USAGE_MAX_OUTPUT_BYTES,
  ANTIGRAVITY_USAGE_TIMEOUT_MS
} from './antigravity-usage-command'
import { parseAntigravityUsageStdout } from './antigravity-usage-response'

export type AgyResult = Pick<ProcessResult, 'code' | 'stdout' | 'stderr' | 'timedOut'> & {
  signal?: ProcessResult['signal']
  environmentResolved?: boolean
}

export type AgyRun = (args: readonly string[], timeoutMs: number) => Promise<AgyResult>

export type AntigravityHostRunnerOptions = {
  runCommand?: typeof runProcess
  resolveCommand?: AntigravityHostProgramOptions['resolveCommand']
  resolveEnvironment?: () => Promise<NodeJS.ProcessEnv>
  credentialPresence?: AntigravityHostProgramOptions['credentialPresence']
  platform?: NodeJS.Platform
  signal?: AbortSignal
  networkProxySettings?: NetworkProxySettings
}

export type AntigravityHostRunner =
  | { kind: 'missing' }
  | { kind: 'login-unreadable'; message: string; failureKind: UsageRateLimitFailureKind }
  | { kind: 'ready'; run: AgyRun; runUsage: (now: () => number) => Promise<AgyResult> }

export async function createAntigravityHostRunner(
  command: string,
  options: AntigravityHostRunnerOptions
): Promise<AntigravityHostRunner> {
  const platform = options.platform ?? process.platform
  const resolveEnvironment = options.resolveEnvironment ?? (() => hostShellEnvironment())
  // Why the env agent launches use: agy lives on the login-shell or saved Windows PATH, not Electron's.
  const env = { ...(await resolveEnvironment()), ...ANTIGRAVITY_PROBE_ENV }
  const resolved = await resolveAntigravityHostProgram(command, { ...options, platform, env })
  if (resolved.kind !== 'found') {
    return resolved
  }
  // agy is a Go CLI that reads only proxy env vars; WSL runs keep the guest's own proxy env.
  const resolvedProxy = await resolveConfiguredOrSystemProxyEnv(env, {
    targetUrl: ANTIGRAVITY_PROXY_PROBE_URL,
    settings: options.networkProxySettings,
    signal: options.signal
  })
  const runCommand = options.runCommand ?? runProcess
  const makeRun =
    (probeEnv: NodeJS.ProcessEnv): AgyRun =>
    (args, timeoutMs) =>
      runCommand({
        program: resolved.program,
        args,
        env: probeEnv,
        timeoutMs,
        maxOutputBytes: ANTIGRAVITY_USAGE_MAX_OUTPUT_BYTES,
        signal: options.signal
      })
  const run = makeRun(resolvedProxy.env)
  const runUsage = async (now: () => number): Promise<AgyResult> => {
    const usageStartedAt = now()
    const result = await run(ANTIGRAVITY_USAGE_ARGS, ANTIGRAVITY_USAGE_TIMEOUT_MS)
    if (
      !resolvedProxy.usedSystemProxy ||
      parseAntigravityUsageStdout(result.stdout) ||
      result.timedOut ||
      options.signal?.aborted ||
      !shouldRetryDirectAfterSystemProxyFailure(
        `${result.stdout}\n${result.stderr}`,
        resolvedProxy.hasDirectFallback
      )
    ) {
      return result
    }
    // Go net/http cannot negotiate 407 NTLM/Kerberos or fall through PAC "; DIRECT" automatically.
    const remainingBudgetMs = Math.max(
      1_000,
      ANTIGRAVITY_USAGE_TIMEOUT_MS - Math.max(0, now() - usageStartedAt)
    )
    return makeRun(env)(ANTIGRAVITY_USAGE_ARGS, remainingBudgetMs)
  }
  return { kind: 'ready', run, runUsage }
}
