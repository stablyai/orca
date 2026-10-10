/**
 * Keeps an SSH host's relayed `orca` CLI inside that host's own terminals.
 *
 * Without the per-target opt-in, the bridge reaches only these methods, and each selector must
 * resolve to a terminal on the bridged host; orchestration callers are bound the same way. Terminals whose host cannot be named are refused:
 * failing closed is the only safe answer for a credential that must not reach other hosts.
 */
import { toSshExecutionHostId } from '../../../shared/execution-host'
import type { RuntimeTerminalListResult } from '../../../shared/runtime-terminal-contracts'
import type { OrcaRuntimeService } from '../orca-runtime'
import {
  findSshBridgeOrchestrationViolation,
  isHostTerminal,
  parseSshBridgeSelectors,
  SSH_BRIDGE_ORCHESTRATION_METHODS,
  type SshBridgeSelectors
} from './ssh-bridge-orchestration-binding'

export const SSH_BRIDGE_REMOTE_CONTROL_HINT =
  'To let that host\'s CLI control this Orca, enable "Allow this host\'s orca CLI to control Orca" in Settings > SSH for that host.'

export type SshBridgeResultFilter = (
  result: unknown
) => { kind: 'denied'; message: string } | { kind: 'allowed'; result: unknown }

export type SshBridgeCallBinding =
  | { kind: 'denied'; message: string }
  | { kind: 'allowed'; filterResult?: SshBridgeResultFilter }

type SshBridgeBinder = (
  runtime: OrcaRuntimeService,
  targetId: string,
  methodName: string,
  selectors: SshBridgeSelectors
) => Promise<SshBridgeCallBinding>

const bindTerminalHandle: SshBridgeBinder = async (runtime, targetId, _methodName, selectors) => {
  const handle = selectors.terminal
  return handle && (await isHostTerminal(runtime, toSshExecutionHostId(targetId), handle))
    ? { kind: 'allowed' }
    : { kind: 'denied', message: outsideHostMessage(targetId, `terminal '${handle ?? ''}'`) }
}

const bindOrchestration: SshBridgeBinder = async (runtime, targetId, methodName, selectors) => {
  const violation = await findSshBridgeOrchestrationViolation(
    runtime,
    toSshExecutionHostId(targetId),
    methodName,
    selectors
  )
  return violation
    ? { kind: 'denied', message: outsideHostMessage(targetId, violation) }
    : { kind: 'allowed' }
}

/** Every method an unopted bridge may reach, each with how its selectors are bound to the host. */
export const SSH_BRIDGE_HOST_BINDERS: ReadonlyMap<string, SshBridgeBinder> = new Map<
  string,
  SshBridgeBinder
>([
  ['status.get', async () => ({ kind: 'allowed' })],
  [
    'terminal.list',
    async (_runtime, targetId, _methodName, { worktree }) => ({
      kind: 'allowed',
      filterResult: (result) => filterTerminalListToHost(result, targetId, worktree)
    })
  ],
  ['terminal.show', bindTerminalHandle],
  ['terminal.read', bindTerminalHandle],
  ['terminal.send', bindTerminalHandle],
  ['terminal.wait', bindTerminalHandle],
  ...SSH_BRIDGE_ORCHESTRATION_METHODS.map((method): [string, SshBridgeBinder] => [
    method,
    bindOrchestration
  ])
])

export function bindSshBridgeCall(
  runtime: OrcaRuntimeService,
  targetId: string,
  methodName: string,
  params: unknown
): Promise<SshBridgeCallBinding> {
  const bind = SSH_BRIDGE_HOST_BINDERS.get(methodName)
  // Why: the dispatcher admits only table methods, so a miss is unreachable and must fail closed.
  return bind
    ? bind(runtime, targetId, methodName, parseSshBridgeSelectors(params))
    : Promise.resolve({
        kind: 'denied',
        message: outsideHostMessage(targetId, `method '${methodName}'`)
      })
}

function filterTerminalListToHost(
  result: unknown,
  targetId: string,
  worktreeSelector: string | undefined
): ReturnType<SshBridgeResultFilter> {
  const hostId = toSshExecutionHostId(targetId)
  if (!isTerminalListResult(result)) {
    return { kind: 'denied', message: 'Terminal listing could not be scoped to the SSH host.' }
  }
  const terminals = result.terminals.filter((terminal) => terminal.executionHostId === hostId)
  if (worktreeSelector && terminals.length !== result.terminals.length) {
    return {
      kind: 'denied',
      message: outsideHostMessage(targetId, `worktree '${worktreeSelector}'`)
    }
  }
  const worktreeIds = new Set(terminals.map((terminal) => terminal.worktreeId))
  const scoped: RuntimeTerminalListResult = {
    terminals,
    totalCount: terminals.length,
    truncated: result.truncated && terminals.length === result.terminals.length,
    ...(result.visualLayouts
      ? {
          visualLayouts: result.visualLayouts.filter((layout) => worktreeIds.has(layout.worktreeId))
        }
      : {}),
    ...(result.topologyRevisions
      ? {
          topologyRevisions: Object.fromEntries(
            Object.entries(result.topologyRevisions).filter(([worktreeId]) =>
              worktreeIds.has(worktreeId)
            )
          )
        }
      : {}),
    ...(result.hostScope
      ? {
          hostScope: {
            hostIds: result.hostScope.hostIds.filter((id) => id === hostId),
            omittedHostIds: result.hostScope.omittedHostIds.filter((id) => id === hostId)
          }
        }
      : {})
  }
  return { kind: 'allowed', result: scoped }
}

function isTerminalListResult(value: unknown): value is RuntimeTerminalListResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    'terminals' in value &&
    Array.isArray(value.terminals) &&
    'truncated' in value &&
    typeof value.truncated === 'boolean'
  )
}

function outsideHostMessage(targetId: string, subject: string): string {
  return `The orca CLI on SSH host '${targetId}' can only reach that host's own terminals and the coordinator that dispatched them, and ${subject} is outside that. ${SSH_BRIDGE_REMOTE_CONTROL_HINT}`
}
