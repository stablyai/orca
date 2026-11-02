import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeProfileRouter } from '../../../claude-accounts/claude-profile-router'
import { installClaudeProfileRouter } from '../../../claude-accounts/claude-profile-installed-router'
import type { ClaudeRuntimeAuthPreparation } from '../../../claude-accounts/runtime-auth-service'
import {
  CLAUDE_INJECTED_CONFIG_DIR_ENV,
  CLAUDE_PROFILE_POINTER_ENV,
  CLAUDE_USER_CONFIG_DIR_ENV
} from '../../../../shared/claude-profile-routing'
import { resetUserAnthropicBaseUrlNote } from '../../../claude-accounts/claude-auth-proxy/claude-auth-proxy-note'
import * as claudeAuthProxyHost from '../../../claude-accounts/claude-auth-proxy/claude-auth-proxy-host'
import { applyRuntimeClaudeAuthEnv, resolveRuntimeClaudeAuth } from './spawn-claude-auth'

const selected: ClaudeRuntimeAuthPreparation = {
  configDir: '/a',
  envPatch: { CLAUDE_CONFIG_DIR: '/a' },
  provenance: 'profile:a'
}
const target: ClaudeRuntimeAuthPreparation = {
  configDir: '/b',
  envPatch: { CLAUDE_CONFIG_DIR: '/b' },
  provenance: 'profile:b'
}

afterEach(() => {
  installClaudeProfileRouter(undefined)
})

describe('resolveRuntimeClaudeAuth', () => {
  it('uses the selected account unless the spawn names one', async () => {
    const prepareClaudeAuth = vi.fn(async () => selected)
    const prepareLaunchFor = vi.fn(async () => target)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only prepareLaunchFor is read here.
    installClaudeProfileRouter({ prepareLaunchFor } as unknown as ClaudeProfileRouter)
    const codexSelectionTarget = { runtime: 'host' as const }

    await expect(
      resolveRuntimeClaudeAuth({ args: {}, deps: { prepareClaudeAuth }, codexSelectionTarget })
    ).resolves.toBe(selected)
    expect(prepareClaudeAuth).toHaveBeenCalledWith(codexSelectionTarget)

    await expect(
      resolveRuntimeClaudeAuth({
        args: { claudeAccountId: 'b' },
        deps: { prepareClaudeAuth },
        codexSelectionTarget
      })
    ).resolves.toBe(target)
    expect(prepareLaunchFor).toHaveBeenCalledWith('b')
  })

  it('refuses a named account when no router is installed, and yields null without any resolver', async () => {
    await expect(
      resolveRuntimeClaudeAuth({
        args: { claudeAccountId: 'b' },
        deps: {},
        codexSelectionTarget: { runtime: 'host' }
      })
    ).rejects.toThrow('claude_account_router_unavailable')
    await expect(
      resolveRuntimeClaudeAuth({ args: {}, deps: {}, codexSelectionTarget: { runtime: 'host' } })
    ).resolves.toBeNull()
  })

  it('relaunches a remembered session on the assigned account, and leaves other resumes on the selection', async () => {
    const prepareClaudeAuth = vi.fn(async () => selected)
    const prepareLaunchFor = vi.fn(async () => target)
    const assignedAccountForResume = vi.fn((sessionId: string) =>
      sessionId === 'sess-moved' ? 'b' : null
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only these two methods are read here.
    installClaudeProfileRouter({
      prepareLaunchFor,
      assignedAccountForResume
    } as unknown as ClaudeProfileRouter)
    const codexSelectionTarget = { runtime: 'host' as const }
    const resume = (id: string) =>
      resolveRuntimeClaudeAuth({
        args: { resumeProviderSession: { key: 'session_id', id } },
        deps: { prepareClaudeAuth },
        codexSelectionTarget
      })

    await expect(resume('sess-moved')).resolves.toBe(target)
    expect(prepareLaunchFor).toHaveBeenCalledWith('b')
    await expect(resume('sess-other')).resolves.toBe(selected)
    expect(prepareClaudeAuth).toHaveBeenCalledTimes(1)
  })
})

describe('applyRuntimeClaudeAuthEnv', () => {
  const terminalEnv = {
    KEEP: '1',
    [CLAUDE_PROFILE_POINTER_ENV]: '/data/claude-profiles/selected-host',
    [CLAUDE_USER_CONFIG_DIR_ENV]: '/home/u/.claude-own'
  }
  const selectedEnv = {
    ...terminalEnv,
    [CLAUDE_INJECTED_CONFIG_DIR_ENV]: '/a',
    CLAUDE_CONFIG_DIR: '/a'
  }

  it('returns the env untouched when there is no Claude auth', () => {
    expect(applyRuntimeClaudeAuthEnv(undefined, null, false)).toBeUndefined()
    expect(applyRuntimeClaudeAuthEnv(selectedEnv, null, true)).toBe(selectedEnv)
  })

  it("keeps the selected account's pointer and markers for an unpinned launch and spreads the patch", () => {
    expect(applyRuntimeClaudeAuthEnv(terminalEnv, selected, false)).toEqual({
      ...terminalEnv,
      CLAUDE_CONFIG_DIR: '/a'
    })
  })

  it('drops the pointer, the injected marker and the selected CLAUDE_CONFIG_DIR for a pinned launch, keeps the user dir, then applies the patch', () => {
    expect(applyRuntimeClaudeAuthEnv(selectedEnv, target, true)).toEqual({
      KEEP: '1',
      [CLAUDE_USER_CONFIG_DIR_ENV]: '/home/u/.claude-own',
      CLAUDE_CONFIG_DIR: '/b'
    })
    expect(selectedEnv.CLAUDE_CONFIG_DIR).toBe('/a')
    expect(selectedEnv).toHaveProperty(CLAUDE_PROFILE_POINTER_ENV)
  })

  it("resumes an account System default covers on the user's own folder, never the selected one", () => {
    const covered = (envPatch: ClaudeRuntimeAuthPreparation['envPatch']) => ({
      configDir: '/home/u/.claude-own',
      envPatch,
      provenance: 'system' as const
    })
    expect(
      applyRuntimeClaudeAuthEnv(
        selectedEnv,
        covered({ CLAUDE_CONFIG_DIR: '/home/u/.claude-own' }),
        true
      )
    ).toEqual({
      KEEP: '1',
      [CLAUDE_USER_CONFIG_DIR_ENV]: '/home/u/.claude-own',
      CLAUDE_CONFIG_DIR: '/home/u/.claude-own'
    })
    const unset = applyRuntimeClaudeAuthEnv(selectedEnv, covered({}), true)
    expect(unset).toEqual({ KEEP: '1', [CLAUDE_USER_CONFIG_DIR_ENV]: '/home/u/.claude-own' })
    expect(unset).not.toHaveProperty('CLAUDE_CONFIG_DIR')
    expect(unset).not.toHaveProperty(CLAUDE_INJECTED_CONFIG_DIR_ENV)
    expect(unset).not.toHaveProperty(CLAUDE_PROFILE_POINTER_ENV)
  })

  it('keeps a user-set ANTHROPIC_BASE_URL instead of the proxy slot', () => {
    resetUserAnthropicBaseUrlNote()
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const env = applyRuntimeClaudeAuthEnv(
      { ...terminalEnv, ANTHROPIC_BASE_URL: 'https://gateway.example' },
      {
        ...selected,
        envPatch: {
          CLAUDE_CONFIG_DIR: '/a',
          ANTHROPIC_BASE_URL: 'http://127.0.0.1:9/p/slot/'
        }
      },
      false
    )
    expect(env?.ANTHROPIC_BASE_URL).toBe('https://gateway.example')
    expect(env?.CLAUDE_CONFIG_DIR).toBe('/a')
    expect(info).toHaveBeenCalled()
    info.mockRestore()
    resetUserAnthropicBaseUrlNote()
  })

  it('keeps a loopback user URL that is not a proxy slot', () => {
    resetUserAnthropicBaseUrlNote()
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const env = applyRuntimeClaudeAuthEnv(
      { ...terminalEnv, ANTHROPIC_BASE_URL: 'http://127.0.0.1:8080/v1' },
      {
        ...selected,
        envPatch: {
          CLAUDE_CONFIG_DIR: '/a',
          ANTHROPIC_BASE_URL: 'http://127.0.0.1:9/p/slot/'
        }
      },
      false
    )
    expect(env?.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8080/v1')
    expect(info).toHaveBeenCalled()
    info.mockRestore()
    resetUserAnthropicBaseUrlNote()
  })

  it("replaces another machine's loopback slot with this host's slot", () => {
    resetUserAnthropicBaseUrlNote()
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const env = applyRuntimeClaudeAuthEnv(
      { ...terminalEnv, ANTHROPIC_BASE_URL: 'http://127.0.0.1:9/p/desktop-slot/' },
      {
        ...selected,
        envPatch: {
          CLAUDE_CONFIG_DIR: '/a',
          ANTHROPIC_BASE_URL: 'http://127.0.0.1:4010/p/host-slot/'
        }
      },
      false
    )
    expect(env?.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:4010/p/host-slot/')
    expect(info).not.toHaveBeenCalled()
    info.mockRestore()
    resetUserAnthropicBaseUrlNote()
  })

  it('prefers this process launch slot over the terminal slot and does not treat it as a user URL', () => {
    resetUserAnthropicBaseUrlNote()
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(claudeAuthProxyHost, 'claudeAuthProxyListeningPort').mockReturnValue(4010)
    const release = vi
      .spyOn(claudeAuthProxyHost, 'releaseOwnClaudeAuthProxySlot')
      .mockImplementation(() => {})
    const env = applyRuntimeClaudeAuthEnv(
      { ...terminalEnv, ANTHROPIC_BASE_URL: 'http://127.0.0.1:4010/p/terminal-slot/' },
      {
        ...selected,
        envPatch: {
          CLAUDE_CONFIG_DIR: '/a',
          ANTHROPIC_BASE_URL: 'http://127.0.0.1:4010/p/launch-slot/'
        }
      },
      false
    )
    expect(env?.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:4010/p/launch-slot/')
    expect(release).toHaveBeenCalledWith('terminal-slot')
    expect(info).not.toHaveBeenCalled()
    info.mockRestore()
    release.mockRestore()
    vi.mocked(claudeAuthProxyHost.claudeAuthProxyListeningPort).mockRestore()
    resetUserAnthropicBaseUrlNote()
  })
})
