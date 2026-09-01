// U5: opaque one-release legacy-config replay. Proves provider resume flags are
// appended exactly once to the one-shot command (never the durable config), that
// Orca attribution env is stripped, and that every failure mode fails closed to
// invalid_launch_snapshot without a partial replay.
import { describe, expect, it } from 'vitest'
import {
  RESUMABLE_TUI_AGENTS,
  getAgentResumeArgv,
  providerSessionKeyForResumableBase
} from '../../shared/agent-session-resume'
import { buildLegacyResumeReplay } from './agent-launch-legacy-replay'

function replay(overrides: Partial<Parameters<typeof buildLegacyResumeReplay>[0]> = {}) {
  return buildLegacyResumeReplay({
    legacyLaunchConfig: { agentCommand: 'claude', agentArgs: '--model opus', agentEnv: {} },
    requestedAgent: 'claude',
    baseAgent: 'claude',
    providerSession: { key: 'session_id', id: 'sess-1' },
    shell: 'posix',
    recordedConnectionId: null,
    currentConnectionId: null,
    ...overrides
  })
}

describe('buildLegacyResumeReplay', () => {
  it('appends the provider resume flags to the one-shot command only', () => {
    const result = replay()
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.launchCommand).toContain('--resume')
    expect(result.launchCommand).toContain('sess-1')
    // Durable config keeps the base args only, so a fresh relaunch never re-resumes.
    expect(result.launchConfig.agentArgs).toBe('--model opus')
    expect(result.launchConfig.agentArgs).not.toContain('--resume')
    expect(result.launchConfig.agentCommand).toBe('claude')
  })

  it('appends resume argv once for every resumable base', () => {
    for (const base of RESUMABLE_TUI_AGENTS) {
      const key = providerSessionKeyForResumableBase(base)
      // Pi and Prime-Agent resume by transcript path, not id; the bases that
      // resume by id ignore it, so every base gets one.
      const providerSession = {
        key,
        id: 'sess-9',
        transcriptPath: '/tmp/transcripts/session.jsonl'
      } as const
      const result = replay({ baseAgent: base, requestedAgent: base, providerSession })
      expect(result.ok, `base ${base}`).toBe(true)
      if (!result.ok) {
        continue
      }
      const resumeArgv = getAgentResumeArgv(base, providerSession)
      expect(resumeArgv).not.toBeNull()
      // The resume marker appears exactly once in the one-shot command. argv[1]
      // is always the flag or subcommand; splitting on '=' also covers copilot's
      // combined `--resume=<id>` form, whose argv has no separate value element.
      const marker = resumeArgv![1]!.split('=')[0]!
      const occurrences = result.launchCommand.split(marker).length - 1
      expect(occurrences, `base ${base} marker ${marker}`).toBe(1)
    }
  })

  it("carries copilot's combined --resume=<id> form into the one-shot command", () => {
    const result = replay({
      baseAgent: 'copilot',
      requestedAgent: 'copilot',
      legacyLaunchConfig: { agentCommand: 'copilot', agentArgs: '', agentEnv: {} },
      providerSession: { key: 'session_id', id: 'sess-42' }
    })
    expect(result.ok && result.launchCommand).toContain('--resume=sess-42')
    // Durable config stays base-only so a fresh relaunch never re-resumes.
    expect(result.ok && result.launchConfig.agentArgs).toBe('')
  })

  it('uses and preserves the captured OMP resume file path', () => {
    const result = replay({
      baseAgent: 'omp',
      requestedAgent: 'omp',
      legacyLaunchConfig: {
        agentCommand: 'omp',
        agentArgs: '',
        agentEnv: {},
        ompResumeFilePath: '/custom/omp/project/session.jsonl'
      }
    })
    expect(result.ok && result.launchCommand).toContain(
      "'--resume' '/custom/omp/project/session.jsonl'"
    )
    expect(result.ok && result.launchConfig.ompResumeFilePath).toBe(
      '/custom/omp/project/session.jsonl'
    )
  })

  it('strips Orca attribution and tmux identity env before replay', () => {
    const result = replay({
      legacyLaunchConfig: {
        agentCommand: 'claude',
        agentArgs: '',
        agentEnv: {
          FOO: 'bar',
          ORCA_PANE_KEY: 'p',
          ORCA_AGENT_LAUNCH_TOKEN: 't',
          TMUX: 'x',
          TMUX_PANE: '%1'
        }
      }
    })
    expect(result.ok && result.launchConfig.agentEnv).toEqual({ FOO: 'bar' })
  })

  it('strips captured Agent Teams identity and the shim PATH prefix from the durable config', () => {
    const result = replay({
      legacyLaunchConfig: {
        agentCommand: 'claude',
        agentArgs: '',
        agentEnv: {
          CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
          TERM: 'screen-256color',
          TMUX: 'x',
          TMUX_PANE: '%1',
          ORCA_AGENT_TEAMS_TOKEN: 'stale-token',
          ORCA_AGENT_TEAMS_SHIM_DIR: '/home/me/.orca/teams-bin',
          PATH: '/home/me/.orca/teams-bin:/usr/bin',
          MY_TOKEN: 'keep'
        }
      }
    })
    // Generated team identity and stale token are gone; the user PATH tail and
    // custom key survive so the downstream path can regenerate a fresh team plan.
    expect(result.ok && result.launchConfig.agentEnv).toEqual({
      PATH: '/usr/bin',
      MY_TOKEN: 'keep'
    })
  })

  it('fails closed when the recorded owner differs from the current owner', () => {
    expect(replay({ recordedConnectionId: 'ssh:a', currentConnectionId: 'ssh:b' }).ok).toBe(false)
  })

  it('fails closed on an empty command', () => {
    expect(
      replay({ legacyLaunchConfig: { agentCommand: '', agentArgs: '', agentEnv: {} } }).ok
    ).toBe(false)
    expect(replay({ legacyLaunchConfig: { agentArgs: '', agentEnv: {} } }).ok).toBe(false)
  })

  it('fails closed on a control character in the command', () => {
    expect(
      replay({ legacyLaunchConfig: { agentCommand: 'claude\n rm', agentArgs: '', agentEnv: {} } })
        .ok
    ).toBe(false)
  })

  it('fails closed when the session key type does not match the base', () => {
    // claude is session_id-keyed; a conversation_id session cannot resume it.
    expect(replay({ providerSession: { key: 'conversation_id', id: 'x' } }).ok).toBe(false)
  })
})
