import type { AgentHookEventPayload } from '../../shared/agent-hook-listener/listener-event'
import type { ClaudeAccountSelectionTarget } from '../claude-accounts/runtime-selection'
import {
  normalizeClaudeResumeOrigin,
  type ClaudeResumeOrigin
} from '../../shared/claude-resume-origin'
import { wslHookRelayConnectionId } from '../../shared/wsl-hook-relay-contract'
import { sameWslDistroName } from '../../shared/windows-path-access'
import { getPublishedHostDescriptor } from '../runtime/host-descriptor'
import type { RuntimePtyWorktreeRecord } from '../runtime/runtime-terminal-state-records'

export function resolveClaudeResumeLaunchOrigin(
  runtime: { getRuntimeId?: () => string } | null | undefined,
  target: ClaudeAccountSelectionTarget
): ClaudeResumeOrigin | undefined {
  const runtimeId = runtime?.getRuntimeId?.()
  const descriptor = runtimeId ? getPublishedHostDescriptor(runtimeId) : null
  if (!descriptor?.machineBinding || (target.runtime === 'wsl' && !target.wslDistro)) {
    return undefined
  }
  return normalizeClaudeResumeOrigin({
    installationId: descriptor.installationId,
    machineBinding: descriptor.machineBinding,
    host: target.runtime === 'wsl' ? { kind: 'wsl', distro: target.wslDistro } : { kind: 'local' }
  })
}

export function resolveClaudeHookResumeOrigin(
  runtime: { getRuntimeId?: () => string },
  row: AgentHookEventPayload,
  pty: Pick<
    RuntimePtyWorktreeRecord,
    | 'connected'
    | 'incarnationId'
    | 'launchToken'
    | 'worktreeId'
    | 'connectionId'
    | 'isWsl'
    | 'wslDistro'
  > | null
): ClaudeResumeOrigin | undefined {
  if (
    !pty?.connected ||
    !pty.incarnationId ||
    !pty.launchToken ||
    row.launchToken !== pty.launchToken ||
    row.worktreeId !== pty.worktreeId ||
    pty.connectionId !== null ||
    pty.isWsl === null
  ) {
    return undefined
  }
  if (pty.isWsl) {
    if (
      !pty.wslDistro ||
      !row.connectionId ||
      !sameWslDistroName(row.connectionId, wslHookRelayConnectionId(pty.wslDistro))
    ) {
      return undefined
    }
    return resolveClaudeResumeLaunchOrigin(runtime, { runtime: 'wsl', wslDistro: pty.wslDistro })
  }
  return row.connectionId === null
    ? resolveClaudeResumeLaunchOrigin(runtime, { runtime: 'host' })
    : undefined
}
