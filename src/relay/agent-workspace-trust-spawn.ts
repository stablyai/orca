import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseAgentWorkspaceTrustSpawnRequest } from '../shared/agent-workspace-trust-spawn-request'
import { TUI_AGENT_CONFIG } from '../shared/tui-agent-config'
import type { TuiAgent } from '../shared/tui-agent'
import { resolveClaudeGlobalConfigFile } from '../main/claude/claude-folder-trust-file'
import { SHORT_AGENT_TRUST_WRITE_DEADLINE_MS } from '../main/agent-trust-write-deadline'
import {
  applyWorkspaceTrustOnThisHost,
  launchedAgentHome
} from '../main/execution-host-workspace-trust'

/**
 * Why here: this host owns the files the agent reads, so each writer's lock, re-read, atomic
 * rename and refusal rules act on local disk, with no round trip across the SSH link.
 */
export async function applyRelayAgentWorkspaceTrust(
  rawRequest: unknown,
  launchAgent: TuiAgent | undefined,
  spawnEnv: Record<string, string | undefined>,
  launch: { wslShell: boolean }
): Promise<void> {
  const request = parseAgentWorkspaceTrustSpawnRequest(rawRequest)
  const preset = launchAgent ? TUI_AGENT_CONFIG[launchAgent].preflightTrust : undefined
  // Why: an agent inside a WSL guest reads the guest's files, not this Windows host's, and
  // Antigravity's writer is unverified on SSH hosts, so it still asks there.
  if (!request || !preset || preset === 'antigravity' || launch.wslShell) {
    return
  }
  await applyWorkspaceTrustOnThisHost(preset, request.workspacePath, () => {
    const keyStyle = process.platform === 'win32' ? 'win32' : 'posix'
    const homeDir = launchedAgentHome(spawnEnv)
    return {
      homes: [homeDir, homedir()],
      agentHome: homeDir,
      kimiHome: (spawnEnv.KIMI_CODE_HOME ?? process.env.KIMI_CODE_HOME)?.trim(),
      claudeConfig: () => ({
        configFile: resolveClaudeGlobalConfigFile({
          env: spawnEnv,
          homeDir,
          style: keyStyle,
          exists: existsSync
        }),
        keyStyle
      }),
      codexConfigFiles: () => [join(spawnEnv.CODEX_HOME || join(homeDir, '.codex'), 'config.toml')],
      // Why: every write here is on the relay's own disk, so each preset gets the local budget.
      deadlineMs: SHORT_AGENT_TRUST_WRITE_DEADLINE_MS
    }
  })
}
