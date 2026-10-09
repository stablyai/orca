import { describe, expect, it, vi } from 'vitest'
import { IDENTITY, record, resolverFor } from './claude-structured-launch-resolution.test-fixture'
import { createClaudeStructuredLaunchResolver } from './claude-structured-launch-resolution'
describe('Claude launch environment and attachments', () => {
  it('keeps the session launch environment pinned after account settings change', async () => {
    const resolver = resolverFor(record(), () => ({
      ANTHROPIC_AUTH_TOKEN: 'rotated-token',
      ANTHROPIC_BASE_URL: 'https://gateway.example.test'
    }))

    expect((await resolver({ identity: IDENTITY })).env).toMatchObject({
      ANTHROPIC_AUTH_TOKEN: 'rotated-token',
      ANTHROPIC_BASE_URL: 'https://gateway.example.test'
    })
    expect((await resolver({ identity: IDENTITY })).env?.ANTHROPIC_AUTH_TOKEN).toBe('rotated-token')
  })

  // Stripping is the managed-account rule the terminal preflight computes at
  // runtime-auth-preparation.ts:72; claude-structured-auth-parity.test.ts covers
  // the system-auth half, where the user's own key has to survive.
  it('strips ambient Anthropic auth under a managed account but keeps the rest of the env', async () => {
    const restore = {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
      CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
      ORCA_LAUNCH_RESOLUTION_MARKER: process.env.ORCA_LAUNCH_RESOLUTION_MARKER
    }
    process.env.ANTHROPIC_API_KEY = 'sk-ant-SHELL-LEAK'
    process.env.ANTHROPIC_AUTH_TOKEN = 'tok-SHELL-LEAK'
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-SHELL-LEAK'
    process.env.ORCA_LAUNCH_RESOLUTION_MARKER = 'inherited'
    try {
      const launch = await resolverFor(record(), undefined, true)({ identity: IDENTITY })

      expect(launch.env?.ANTHROPIC_API_KEY).toBeUndefined()
      expect(launch.env?.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
      expect(launch.env?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
      // The inherited env is still the base — only auth is removed from it.
      expect(launch.env?.ORCA_LAUNCH_RESOLUTION_MARKER).toBe('inherited')
      expect(launch.env?.PATH ?? launch.env?.Path).toBeTruthy()
    } finally {
      for (const [key, value] of Object.entries(restore)) {
        if (value === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = value
        }
      }
    }
  })

  it("lets the agent read the host's chat attachment store, outside the workspace", async () => {
    const launch = await resolverFor(
      record(),
      undefined,
      false,
      async () => true,
      undefined,
      '/state/agent-session-attachments'
    )({ identity: IDENTITY })

    expect(launch.options.additionalDirectories).toEqual(['/state/agent-session-attachments'])
    expect(launch.cwd).toBe('/repos/workspace-1')
  })

  it('grants the attachment store beside folders the saved Arguments add', async () => {
    const launch = await resolverFor(
      record(),
      undefined,
      false,
      async () => true,
      () => ['--add-dir', '/extra'],
      '/state/agent-session-attachments'
    )({ identity: IDENTITY })

    expect(launch.options.additionalDirectories).toEqual([
      '/extra',
      '/state/agent-session-attachments'
    ])
  })

  it('builds on the supplied inherited env instead of Orca process env', async () => {
    const launch = await createClaudeStructuredLaunchResolver({
      resolveLaunchArgs: () => [],
      store: { getRecord: () => record(), pinLaunchDirectory: vi.fn() },
      resolveWorkspacePath: async (id) => `/repos/${id}`,
      resolveCommand: () => '/usr/local/bin/claude',
      resolveAuthPolicy: () => ({ stripAuthEnv: false }),
      resolveInheritedEnv: async () => ({ PATH: '/shell/bin', SHELL_ONLY_MARKER: 'from-shell' })
    })({ identity: IDENTITY })

    expect(launch.env?.SHELL_ONLY_MARKER).toBe('from-shell')
  })

  it('drops an inherited CLAUDE_CONFIG_DIR so the record stays the only Claude home the pin sees', async () => {
    const launch = await createClaudeStructuredLaunchResolver({
      resolveLaunchArgs: () => [],
      store: { getRecord: () => record(), pinLaunchDirectory: vi.fn() },
      resolveWorkspacePath: async (id) => `/repos/${id}`,
      resolveCommand: () => '/usr/local/bin/claude',
      resolveAuthPolicy: () => ({ stripAuthEnv: false }),
      resolveInheritedEnv: async () => ({
        PATH: '/shell/bin',
        CLAUDE_CONFIG_DIR: '/shell/claude',
        SHELL_ONLY_MARKER: 'from-shell'
      })
    })({ identity: IDENTITY })

    expect(launch.env).not.toHaveProperty('CLAUDE_CONFIG_DIR')
    expect(launch.env?.SHELL_ONLY_MARKER).toBe('from-shell')
    expect(launch.claudeConfigDir).toBe('/home/work/.claude')
  })

  it('keeps a configured overlay CLAUDE_CONFIG_DIR over the dropped inherited one', async () => {
    const launch = await createClaudeStructuredLaunchResolver({
      resolveLaunchArgs: () => [],
      store: { getRecord: () => record(), pinLaunchDirectory: vi.fn() },
      resolveWorkspacePath: async (id) => `/repos/${id}`,
      resolveCommand: () => '/usr/local/bin/claude',
      resolveAuthPolicy: () => ({ stripAuthEnv: false }),
      resolveEnv: () => ({ CLAUDE_CONFIG_DIR: '/accounts/selected/home' }),
      resolveInheritedEnv: async () => ({ PATH: '/shell/bin', CLAUDE_CONFIG_DIR: '/shell/claude' })
    })({ identity: IDENTITY })

    expect(launch.env?.CLAUDE_CONFIG_DIR).toBe('/accounts/selected/home')
  })

  it('still strips an inherited auth key under a managed account', async () => {
    const launch = await createClaudeStructuredLaunchResolver({
      resolveLaunchArgs: () => [],
      store: { getRecord: () => record(), pinLaunchDirectory: vi.fn() },
      resolveWorkspacePath: async (id) => `/repos/${id}`,
      resolveCommand: () => '/usr/local/bin/claude',
      resolveAuthPolicy: () => ({ stripAuthEnv: true }),
      resolveInheritedEnv: async () => ({ PATH: '/shell/bin', ANTHROPIC_API_KEY: 'listed-key' })
    })({ identity: IDENTITY })

    expect(launch.env?.ANTHROPIC_API_KEY).toBeUndefined()
  })

  it('lets an explicit Claude env overlay override ambient auth under system auth', async () => {
    const restore = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'sk-ant-SHELL-LEAK'
    try {
      const launch = await resolverFor(record(), () => ({
        ANTHROPIC_API_KEY: 'sk-ant-CONFIGURED'
      }))({ identity: IDENTITY })

      expect(launch.env?.ANTHROPIC_API_KEY).toBe('sk-ant-CONFIGURED')
    } finally {
      if (restore === undefined) {
        delete process.env.ANTHROPIC_API_KEY
      } else {
        process.env.ANTHROPIC_API_KEY = restore
      }
    }
  })
})
