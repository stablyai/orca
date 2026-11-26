import { mkdir, rename, rmdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  SETUP_AGENT_BLOCKED_MESSAGE,
  SETUP_AGENT_SELECTION_TIMEOUT_SECONDS,
  SETUP_COMPLETE_MESSAGE
} from '../../../../shared/agent-launch/startup/setup-agent-sequencing'
import { createSetupWaitGate } from '../../../../shared/agent-launch/startup/setup-wait-output-gate'
import type { AgentStartupShell } from '../../../../shared/agent-launch/startup/tui-agent-startup-shell'
import type {
  AgentProgramBlockReason,
  SleepingAgentLaunchConfig
} from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import { waitForPromiseWithSignal } from '../../../../shared/concurrency/abort-signal-reason'
import { quotePosixShell } from '../../../../shared/shell/launch/shell-argument-quoting'
import { quotePowerShellLiteral } from '../../../../shared/shell/launch/powershell-native-argument'
import type { TerminalMcpPaneLaunch } from '../../../mcp-servers/terminal/terminal-mcp-launch'
import type { IPtyProvider } from '../../../providers/pty/provider-contract'
import type { PtySpawnResult } from '../../../providers/pty/spawn-result'
import { waitForSequencedSetup } from './wait-for-sequenced-setup'

type PreparedLaunch = {
  command?: string
  blocked?: AgentProgramBlockReason
  startupNotice?: string
  launchConfig?: SleepingAgentLaunchConfig
  terminalMcp: TerminalMcpPaneLaunch | null
  env: Record<string, string>
  envToDelete: string[]
}

export type SequencedAgentLaunch = (
  provider: IPtyProvider,
  result: PtySpawnResult,
  publish: (
    launch: Pick<PreparedLaunch, 'launchConfig' | 'terminalMcp' | 'blocked'> & {
      env?: Record<string, string>
    }
  ) => void
) => void

type GateOwner = {
  incarnationId: PtySpawnResult['incarnationId']
  observe: ReturnType<typeof createSetupWaitGate>['observe']
  stop: () => void
}

const providers = new WeakMap<
  IPtyProvider,
  { gates: Map<string, GateOwner>; dispose: () => void }
>()

function watchGate(provider: IPtyProvider, result: PtySpawnResult, stop: () => void): () => void {
  let registration = providers.get(provider)
  if (!registration) {
    const gates = new Map<string, GateOwner>()
    const offExit = provider.onExit(({ id, incarnationId }) => {
      const gate = gates.get(id)
      if (gate && (!gate.incarnationId || gate.incarnationId === incarnationId)) {
        gate.stop()
      }
    })
    const offData = provider.onData(({ id, data }) => {
      const gate = gates.get(id)
      const phase = gate?.observe(data).phase
      if (phase === 'failed' || phase === 'started') {
        gate.stop()
      }
    })
    registration = {
      gates,
      dispose: () => {
        offData()
        offExit()
        providers.delete(provider)
      }
    }
    providers.set(provider, registration)
  }
  const owner = registration
  const previous = owner.gates.get(result.id)
  const gate = {
    incarnationId: result.incarnationId,
    observe: createSetupWaitGate(true).observe,
    stop
  }
  owner.gates.set(result.id, gate)
  previous?.stop()
  return () => {
    if (owner.gates.get(result.id) === gate) {
      owner.gates.delete(result.id)
      if (owner.gates.size === 0) {
        owner.dispose()
      }
    }
  }
}

function renderSelection(
  launch: PreparedLaunch | undefined,
  shell: AgentStartupShell,
  env: Record<string, string>,
  envToDelete: readonly string[]
): string {
  const powershell = shell === 'powershell'
  const quote = powershell ? quotePowerShellLiteral : quotePosixShell
  const notice = (message: string) =>
    powershell
      ? `[Console]::Error.WriteLine(${quote(message)})`
      : `printf '%s\\n' ${quote(message)} >&2`
  if (!launch?.command || launch.blocked) {
    const message =
      launch?.blocked === 'unavailable'
        ? 'The agent could not be found on this host.'
        : launch?.startupNotice?.trim() || 'Try again.'
    return `${notice(`${SETUP_AGENT_BLOCKED_MESSAGE} ${message}`)}\nexit 1`
  }
  const previousDeletions = new Set(envToDelete)
  const changes = [
    ...launch.envToDelete
      .filter((key) => !previousDeletions.has(key))
      .map((key) => ({ key, value: undefined })),
    ...Object.entries(launch.env)
      .filter(
        ([key, value]) =>
          value !== env[key] || (previousDeletions.has(key) && !launch.envToDelete.includes(key))
      )
      .map(([key, value]) => ({ key, value }))
  ]
  const statements = changes.flatMap(({ key, value }) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      return []
    }
    if (powershell) {
      return [
        `[Environment]::SetEnvironmentVariable(${quote(key)}, ${value === undefined ? '$null' : quote(value)})`
      ]
    }
    return [value === undefined ? `unset ${key}` : `export ${key}=${quote(value)}`]
  })
  return [
    ...statements,
    ...(launch.startupNotice ? [notice(launch.startupNotice.trim())] : []),
    notice(SETUP_COMPLETE_MESSAGE),
    launch.command
  ].join('\n')
}

export function publishSequencedAgentLaunch(args: {
  provider: IPtyProvider
  result: PtySpawnResult
  marker: string
  folder: string
  shell: AgentStartupShell
  env: Record<string, string>
  envToDelete: readonly string[]
  prepare: (signal: AbortSignal) => Promise<PreparedLaunch>
  publish: Parameters<SequencedAgentLaunch>[2]
}): void {
  const { provider, result, marker, folder } = args
  const lifetime = new AbortController()
  const stop = (): void => lifetime.abort()
  const unwatch = watchGate(provider, result, stop)
  const pending = join(folder, 'pending')
  const ready = join(folder, 'ready')
  const run = async (): Promise<void> => {
    let created = false
    try {
      if ((await waitForSequencedSetup(marker, lifetime.signal)) !== 0 || lifetime.signal.aborted) {
        return
      }
      const signal = AbortSignal.any([
        lifetime.signal,
        AbortSignal.timeout(SETUP_AGENT_SELECTION_TIMEOUT_SECONDS * 1000)
      ])
      const launch = await waitForPromiseWithSignal(args.prepare(signal), signal).catch(
        () => undefined
      )
      if (lifetime.signal.aborted) {
        return
      }
      await mkdir(folder, { mode: 0o700 })
      created = true
      await writeFile(pending, renderSelection(launch, args.shell, args.env, args.envToDelete), {
        flag: 'wx',
        mode: 0o600,
        signal: lifetime.signal
      })
      if (lifetime.signal.aborted) {
        return
      }
      args.publish({
        launchConfig: launch?.command ? launch.launchConfig : undefined,
        terminalMcp: launch?.command ? launch.terminalMcp : null,
        blocked: launch?.blocked ?? (launch?.command ? undefined : 'unknown'),
        env: launch?.env
      })
      await rename(pending, ready)
      await waitForPromiseWithSignal(
        new Promise<void>(() => {}),
        AbortSignal.any([
          lifetime.signal,
          AbortSignal.timeout(SETUP_AGENT_SELECTION_TIMEOUT_SECONDS * 1000)
        ])
      ).catch(() => {})
    } finally {
      unwatch()
      if (created) {
        await Promise.allSettled([unlink(pending), unlink(ready)])
        await rmdir(folder).catch(() => {})
      }
    }
  }
  void run().catch(() => {})
}
