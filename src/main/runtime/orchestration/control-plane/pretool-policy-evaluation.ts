import { runCommandForStdout } from './sync-command-output'
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { gitExecFileSync } from '../../../git/runner'
import type { OrchestrationDb } from '../db'
import { OrchestrationError } from '../orchestration-error'
import { worktreePathForDispatch } from './runtime-observed-completion'

const POLICY_PATH = '.codex/hooks/pre_tool_use_policy.py'
const MAX_POLICY_PAYLOAD_BYTES = 256 * 1024

export type RuntimeObservedPretoolDecision = {
  decision: 'allow' | 'block'
  policyId: 'scl-pretool-use-policy'
  policyVersion: string
  toolName: string | null
  reason: string | null
}

/** Whether this exact Dispatch target opts into the SCL policy bridge. Absence
 * means the repository has no such policy, not that a policy verdict was
 * accepted. A present-but-dirty policy is handled fail-closed by evaluation. */
export function hasCommittedPretoolPolicy(args: {
  db: OrchestrationDb
  dispatchId: string
}): boolean {
  const root = worktreePathForDispatch(args.db, args.dispatchId)
  if (!root) {
    return false
  }
  try {
    gitExecFileSync(['show', `HEAD:${POLICY_PATH}`], { cwd: root })
    return true
  } catch {
    return false
  }
}

function parsePolicyOutput(stdout: string): { blocked: boolean; reason: string | null } {
  const trimmed = stdout.trim()
  if (!trimmed) {
    return { blocked: false, reason: null }
  }
  try {
    const parsed = JSON.parse(trimmed) as {
      hookSpecificOutput?: { permissionDecision?: unknown; permissionDecisionReason?: unknown }
      decision?: unknown
      reason?: unknown
    }
    const blocked =
      parsed.hookSpecificOutput?.permissionDecision === 'deny' || parsed.decision === 'block'
    const reason =
      typeof parsed.hookSpecificOutput?.permissionDecisionReason === 'string'
        ? parsed.hookSpecificOutput.permissionDecisionReason
        : typeof parsed.reason === 'string'
          ? parsed.reason
          : null
    return { blocked, reason }
  } catch {
    throw new OrchestrationError(
      'pretool_policy_unreadable',
      'The authoritative PreTool policy returned an unrecognized decision payload.'
    )
  }
}

/** Run the exact committed SCL policy from the Dispatch worktree. The caller
 * requests an evaluation but supplies no verdict: ALLOW/BLOCK, policy version,
 * tool and reason are all derived by the runtime from the policy invocation. */
export function evaluateCommittedPretoolPolicy(args: {
  db: OrchestrationDb
  dispatchId: string
  payload: Record<string, unknown>
}): RuntimeObservedPretoolDecision {
  const root = worktreePathForDispatch(args.db, args.dispatchId)
  if (!root) {
    throw new OrchestrationError(
      'pretool_policy_unobservable',
      `Dispatch ${args.dispatchId} has no runtime-owned local worktree.`
    )
  }
  const policyPath = resolve(root, POLICY_PATH)
  if (policyPath !== root && !policyPath.startsWith(`${resolve(root)}${sep}`)) {
    throw new OrchestrationError('pretool_policy_unobservable', 'Policy path escaped worktree.')
  }
  let committed: Buffer
  let working: Buffer
  try {
    committed = Buffer.from(gitExecFileSync(['show', `HEAD:${POLICY_PATH}`], { cwd: root }))
    if (!statSync(policyPath).isFile()) {
      throw new Error('not a file')
    }
    working = readFileSync(policyPath)
  } catch (error) {
    throw new OrchestrationError(
      'pretool_policy_unobservable',
      `The exact committed SCL PreTool policy is unavailable: ${String(error)}`
    )
  }
  if (!committed.equals(working)) {
    throw new OrchestrationError(
      'pretool_policy_dirty',
      'The working PreTool policy differs from HEAD, so it cannot issue certification evidence.'
    )
  }
  const payloadBytes = Buffer.from(JSON.stringify(args.payload))
  if (payloadBytes.byteLength === 0 || payloadBytes.byteLength > MAX_POLICY_PAYLOAD_BYTES) {
    throw new OrchestrationError(
      'pretool_payload_invalid',
      'PreTool payload is empty or too large.'
    )
  }
  const env = { ...process.env }
  delete env.ORCA_TERMINAL_HANDLE
  delete env.ORCA_PANE_KEY
  delete env.ORCA_AGENT_LAUNCH_TOKEN
  let stdout: string
  try {
    stdout = runCommandForStdout({
      program: '/usr/bin/python3',
      args: [policyPath],
      cwd: root,
      env,
      input: payloadBytes.toString('utf8'),
      timeoutMs: 5_000,
      maxOutputBytes: MAX_POLICY_PAYLOAD_BYTES
    })
  } catch (error) {
    throw new OrchestrationError(
      'pretool_policy_failed',
      `The authoritative PreTool policy did not complete successfully: ${String(error)}`
    )
  }
  const result = parsePolicyOutput(stdout)
  return {
    decision: result.blocked ? 'block' : 'allow',
    policyId: 'scl-pretool-use-policy',
    policyVersion: `sha256:${createHash('sha256').update(committed).digest('hex')}`,
    toolName: typeof args.payload.tool_name === 'string' ? args.payload.tool_name : null,
    reason: result.reason
  }
}
