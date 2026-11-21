import { stripVTControlCharacters } from 'node:util'
import { runProcess } from '@orca/process-host'
import { KIRO_LAUNCH_SPEC } from './kiro-acp-launch-spec'
import { resolveAcpLaunchInvocation } from '../acp/launch/acp-structured-launch-resolution'
import { resolveProviderChildEnv } from '../provider-process/provider-process-launch'
import { structuredAgentHostLaunchSources } from '../runtime/agent-session/launch/structured-agent-launch-support'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'

export function parseKiroChatAgentList(output: string): string[] {
  const names = new Set<string>()
  for (const line of stripVTControlCharacters(output).split(/\r?\n/)) {
    const row = /^[* ] (\S(?:.*?\S)?)\s{2,}(?:Global|Workspace)(?:\s{2,}|$)/.exec(line)
    if (row) {
      names.add(row[1])
    }
  }
  return [...names]
}

export async function listKiroChatAgents(
  runtime: OrcaRuntimeService,
  worktree: string,
  signal?: AbortSignal
) {
  const scope = new AbortController()
  const readSignal = signal ? AbortSignal.any([scope.signal, signal]) : scope.signal
  try {
    const target = await runtime.resolveRuntimeFileTarget(worktree)
    const sources = await structuredAgentHostLaunchSources('kiro', runtime, readSignal)
    const cwd = target.worktree.path
    const launch = await resolveAcpLaunchInvocation(KIRO_LAUNCH_SPEC, sources.accountHome, {
      dataDirectory: sources.dataDirectory,
      resolveEnvironment: async () => sources.env,
      resolveCommandSettings: () => sources.commandSettings,
      resolveWorkingDirectory: () => cwd
    })
    const result = await runProcess({
      program: launch.command,
      args: [...launch.prefixArgs, 'agent', 'list'],
      cwd,
      env: resolveProviderChildEnv(launch, process.env),
      signal: readSignal,
      timeoutMs: 5000,
      maxOutputBytes: 262144,
      killOnOutputLimit: true
    })
    if (result.code !== 0) {
      throw new Error('Kiro could not list agents in this workspace.')
    }
    return parseKiroChatAgentList(`${result.stdout}\n${result.stderr}`)
  } finally {
    scope.abort()
  }
}
