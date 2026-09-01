// The host half of a cold-restore resume. The renderer surrenders an ownership
// key plus (once, for a pre-U5 session) the captured launch config, and asserts
// exactly that payload; everything below is what the host then does with it —
// which shell the argv is quoted for, and that the captured line replays rather
// than current settings. Kept out of the renderer test files so the web project
// never pulls the main graph into its file list.

import { describe, expect, it } from 'vitest'
import type { SleepingAgentLaunchConfig } from '../../shared/agent-session-resume'
import { resolveStartupShell } from '../../shared/tui-agent-startup-shell'
import { AgentSessionRecordStore } from './agent-session-record-store'
import { describeSpawnExecutionHost, platformForDescriptor } from './agent-launch-host-state'
import { buildLegacyResumeReplay } from './agent-launch-legacy-replay'
import {
  resolveResumeLaunchIngest,
  type ResumeLaunchIngestResult
} from './agent-launch-resume-ingest'

const SESSION_KEY = {
  worktreeId: 'wt-1',
  baseAgent: 'codex',
  providerSessionId: 'codex-session-1'
} as const

/** Exactly the fields `pty:spawn` feeds the ingest from a cold-restore spawn. */
function ingestColdRestoreResume(handoff?: SleepingAgentLaunchConfig): ResumeLaunchIngestResult {
  return resolveResumeLaunchIngest(
    {
      resume: { operation: 'resume', sessionKey: SESSION_KEY },
      client: 'desktop',
      legacy: {
        shell: 'posix',
        connectionId: null,
        ...(handoff ? { handoff: { launchConfig: handoff, recordedConnectionId: null } } : {})
      }
    },
    new AgentSessionRecordStore()
  )
}

function expectLegacyReplay(
  ingest: ResumeLaunchIngestResult
): Extract<ResumeLaunchIngestResult, { ok: true; kind: 'legacy' }> {
  if (!ingest.ok || ingest.kind !== 'legacy') {
    throw new Error(`host refused the legacy resume handoff: ${JSON.stringify(ingest)}`)
  }
  return ingest
}

describe('cold-restore resume handoff', () => {
  // The renderer surrenders the CAPTURED line; current `agentDefaultArgs` never
  // reach the host, so a settings change after capture cannot rewrite the resume.
  it('replays the surrendered pre-U5 command and appends the quoted resume argv', () => {
    const replay = expectLegacyReplay(
      ingestColdRestoreResume({
        agentCommand: "codex '--model' 'gpt-5' '--reasoning-effort' 'high'",
        agentArgs: '--model gpt-5 --reasoning-effort high',
        agentEnv: {
          CODEX_PROFILE: 'captured',
          ORCA_PANE_KEY: 'wrong-pane',
          ORCA_TAB_ID: 'wrong-tab',
          ORCA_WORKTREE_ID: 'wrong-worktree',
          ORCA_WORKSPACE_ID: 'wrong-workspace'
        }
      })
    )

    expect(replay.launchCommand).toBe(
      "codex '--model' 'gpt-5' '--reasoning-effort' 'high' 'resume' 'codex-session-1'"
    )
    // Pane identity rides the spawn env, so the record's stale attribution is
    // dropped rather than merged back over the live pane's.
    expect(replay.launchConfig.agentEnv).toEqual({ CODEX_PROFILE: 'captured' })
  })

  it('replays a live entry config surrendered on the current connection', () => {
    const replay = expectLegacyReplay(
      ingestColdRestoreResume({
        agentCommand: "codex '--model' 'gpt-5-mini'",
        agentArgs: '--model gpt-5-mini',
        agentEnv: {}
      })
    )

    expect(replay.launchCommand).toBe("codex '--model' 'gpt-5-mini' 'resume' 'codex-session-1'")
  })

  // A rejected identity lookup leaves the renderer nothing to surrender. The host
  // must fail closed rather than rebuild the line from current settings, so the
  // client can offer "Launch with current settings" explicitly.
  it('fails closed when the spawn carries no handoff and no record exists', () => {
    expect(ingestColdRestoreResume()).toEqual({
      ok: false,
      failure: { code: 'invalid_launch_snapshot' }
    })
  })

  // #12320 on a WSL-runtime project: the worktree is a Windows drive path, so
  // only the project runtime reveals that bash — not PowerShell — runs the resume.
  it('POSIX-quotes the resume argv for a WSL-runtime project on a drive-letter cwd', () => {
    const descriptor = describeSpawnExecutionHost({
      connectionId: null,
      cwd: 'C:\\tmp\\wt-1',
      terminalWindowsShell: 'powershell.exe',
      projectRuntime: {
        status: 'resolved',
        runtime: {
          kind: 'wsl',
          hostPlatform: 'wsl',
          projectId: 'repo1',
          distro: 'Ubuntu',
          reason: 'project-override',
          cacheKey: 'repo1:wsl:Ubuntu'
        }
      }
    })
    expect(descriptor).toEqual({ kind: 'wsl', distro: 'Ubuntu' })

    const replay = buildLegacyResumeReplay({
      legacyLaunchConfig: {
        agentCommand: 'codex --dangerously-bypass-approvals-and-sandbox',
        agentArgs: '--dangerously-bypass-approvals-and-sandbox',
        agentEnv: {}
      },
      requestedAgent: 'codex',
      baseAgent: 'codex',
      providerSession: { key: 'session_id', id: "codex-session-1's" },
      shell: resolveStartupShell(platformForDescriptor(descriptor), descriptor.shell),
      recordedConnectionId: null,
      currentConnectionId: null
    })

    expect(replay.ok && replay.launchCommand).toBe(
      `codex --dangerously-bypass-approvals-and-sandbox 'resume' 'codex-session-1'"'"'s'`
    )
  })
})
