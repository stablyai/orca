import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  prepareStrictClaudeRestart,
  recordedSessionRestartRefusal,
  strictCodexSessionRestartRefusal
} from './spawn-recorded-account'

const managedAccounts = vi.hoisted((): { ids: string[] } => ({ ids: [] }))
vi.mock('../../../managed-data-accounts/service', () => ({
  getManagedDataAccountService: () => ({
    list: () => ({
      accounts: managedAccounts.ids.map((id) => ({ id })),
      activeAccountId: managedAccounts.ids[0] ?? null
    }),
    environmentForAccount: (_provider: string, id: string) => {
      if (!managedAccounts.ids.includes(id)) {
        throw new Error('removed')
      }
      return { XDG_DATA_HOME: `/accounts/${id}/data` }
    },
    launchEnvironment: () => ({})
  })
}))

describe('recordedSessionRestartRefusal', () => {
  it('lets an account-switch restart keep the selected account', () => {
    expect(
      recordedSessionRestartRefusal({
        launchAgent: 'codex',
        env: {}
      })
    ).toBeNull()
  })

  it('does not treat a missing Codex home as unknown, and skips an unproven Claude home', () => {
    expect(
      recordedSessionRestartRefusal({
        resumeOnSelectedAccount: false,
        launchAgent: 'codex',
        env: {}
      })
    ).toBeNull()
    expect(
      prepareStrictClaudeRestart({
        resumeOnSelectedAccount: false,
        launchAgent: 'claude',
        env: {}
      })
    ).toMatch(/could not prove the original Claude account/)
  })

  it('names the OpenCode or Devin account before stop, or refuses when profiles make it ambiguous', () => {
    const account = '0f3c2a8e-5d1b-4c7e-9a64-2b8f1e6d3c90'
    const strict = (launchAgent: string, extra: Record<string, unknown> = {}) => {
      const args = { resumeOnSelectedAccount: false as const, launchAgent, env: {}, ...extra }
      return { refusal: recordedSessionRestartRefusal(args), env: args.env }
    }
    managedAccounts.ids = []
    expect(strict('opencode').refusal).toBeNull()
    managedAccounts.ids = [account]
    expect(strict('opencode').refusal).toMatch(/could not prove the original opencode account/)
    expect(strict('devin').refusal).toMatch(/could not prove the original devin account/)
    expect(strict('devin', { env: { ORCA_DATA_ACCOUNT_ID: 'gone' } }).refusal).toMatch(
      /requires the recorded account/
    )
    expect(
      strict('opencode', {
        resumeProviderSession: {
          key: 'session_id',
          id: 'ses_1',
          transcriptPath: `/u/managed-data-accounts/opencode/${account}/data/opencode/opencode.db#ses_1`
        }
      })
    ).toEqual({ refusal: null, env: { ORCA_DATA_ACCOUNT_ID: account } })
  })

  it('refuses before stop when Codex preparation would start a fresh chat', async () => {
    const prepare = vi.fn(async () => ({ outcome: 'fresh' as const, claimedCodexProvenance: true }))
    await expect(
      strictCodexSessionRestartRefusal(prepare, {
        resumeOnSelectedAccount: false,
        launchAgent: 'codex',
        command: "codex resume 'sess-1'",
        env: { CODEX_HOME: '/accounts/work' },
        resumeProviderSession: { key: 'session_id', id: 'sess-1' }
      })
    ).resolves.toMatch(/new Codex chat|could not verify the originating Codex session/)
    expect(prepare).toHaveBeenCalled()
  })

  it('pins a managed Claude home from the session transcript when launch env is empty', () => {
    const env: Record<string, string> = { ORCA_PANE_KEY: 'pane' }
    const args = {
      resumeOnSelectedAccount: false as const,
      launchAgent: 'claude' as const,
      env,
      resumeProviderSession: {
        key: 'session_id' as const,
        id: 'sess-1',
        transcriptPath: '/accounts/A/projects/-repo/sess-1.jsonl'
      }
    }
    expect(prepareStrictClaudeRestart(args)).toBeNull()
    expect(args.env.CLAUDE_CONFIG_DIR).toBe('/accounts/A')
  })

  it('leaves the default Claude home unpinned so the CLI keeps its Keychain identity', () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', '')
    const strict = (transcriptPath: string, platform: NodeJS.Platform) => {
      const env: Record<string, string> = {}
      const args = {
        resumeOnSelectedAccount: false as const,
        launchAgent: 'claude' as const,
        env,
        resumeProviderSession: { key: 'session_id' as const, id: 'sess-1', transcriptPath }
      }
      expect(prepareStrictClaudeRestart(args, platform)).toBeNull()
      return args.env.CLAUDE_CONFIG_DIR
    }
    expect(
      strict(join(homedir(), '.claude', 'projects', '-repo', 'sess-1.jsonl'), process.platform)
    ).toBeUndefined()
    expect(strict('/home/me/.claude/projects/-repo/sess-1.jsonl', 'win32')).toBeUndefined()
    expect(strict('/home/me/profiles/work/projects/-repo/sess-1.jsonl', 'win32')).toBe(
      '/home/me/profiles/work'
    )
    vi.unstubAllEnvs()
  })

  it('keeps an account-switch restart on the selected-account path', async () => {
    const prepare = vi.fn(async () => ({ outcome: 'fresh' as const, claimedCodexProvenance: true }))
    await expect(
      strictCodexSessionRestartRefusal(prepare, {
        launchAgent: 'codex',
        env: { CODEX_HOME: '/accounts/work' },
        resumeProviderSession: { key: 'session_id', id: 'sess-1' }
      })
    ).resolves.toBeNull()
    expect(prepare).not.toHaveBeenCalled()
  })
})
