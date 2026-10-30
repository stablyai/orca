import { createHash } from 'node:crypto'
import type { PreparedAgentSpawn, PreparedTerminalPrompts } from './prepared-agent-launch-protocol'

export function fingerprintPreparedAgentLaunch(payload: {
  launch: PreparedAgentSpawn
  setup?: { spawn: PreparedAgentSpawn; attemptId: string; deadline: number }
  prompts?: PreparedTerminalPrompts
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({ launch: payload.launch, setup: payload.setup, prompts: payload.prompts })
    )
    .digest('base64url')
}

/** Authenticated payloads still cannot carry internal callbacks or replace lifetime ownership. */
export function copyPreparedAgentSpawn(spawn: PreparedAgentSpawn): PreparedAgentSpawn {
  return structuredClone({
    sessionId: spawn.sessionId,
    cols: spawn.cols,
    rows: spawn.rows,
    cwd: spawn.cwd,
    env: spawn.env,
    envToDelete: spawn.envToDelete,
    command: spawn.command,
    startupCommandDelivery: spawn.startupCommandDelivery,
    launchAgent: spawn.launchAgent,
    shellOverride: spawn.shellOverride,
    terminalShellArgs: spawn.terminalShellArgs,
    terminalWindowsWslDistro: spawn.terminalWindowsWslDistro,
    terminalWindowsPowerShellImplementation: spawn.terminalWindowsPowerShellImplementation,
    shellReadySupported: spawn.shellReadySupported,
    shellReadyTimeoutMs: spawn.shellReadyTimeoutMs,
    startupIngress: spawn.startupIngress,
    spawnIntent: spawn.spawnIntent
  })
}

export function validatePreparedAgentSpawn(spawn: PreparedAgentSpawn): void {
  if (
    !spawn ||
    typeof spawn.sessionId !== 'string' ||
    !spawn.sessionId ||
    !Number.isFinite(spawn.cols) ||
    !Number.isFinite(spawn.rows)
  ) {
    throw new Error('agent_session_operation_invalid')
  }
}
