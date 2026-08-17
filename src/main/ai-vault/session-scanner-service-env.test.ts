import { describe, expect, it } from 'vitest'
import { buildAiVaultServiceEnv, buildRelayAiVaultServiceEnv } from './session-scanner-service-env'

describe('buildAiVaultServiceEnv', () => {
  it('drops Node flag injection variables so the forked heap cap and loader stand', () => {
    const env = buildAiVaultServiceEnv(
      {
        NODE_OPTIONS: '--max-old-space-size=8192 --require=/tmp/evil.js',
        NODE_REPL_EXTERNAL_MODULE: '/tmp/evil.js',
        NODE_PATH: '/tmp/evil-modules',
        PATH: '/usr/bin'
      },
      'linux'
    )

    expect(env.NODE_OPTIONS).toBeUndefined()
    expect(env.NODE_REPL_EXTERNAL_MODULE).toBeUndefined()
    expect(env.NODE_PATH).toBeUndefined()
    expect(env.PATH).toBe('/usr/bin')
  })

  it('drops an unrecognised variable rather than carrying a shell-exported secret', () => {
    const env = buildAiVaultServiceEnv(
      { AWS_SECRET_ACCESS_KEY: 'shhh', HOME: '/home/dev' },
      'linux'
    )

    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined()
    expect(env.HOME).toBe('/home/dev')
  })

  it('keeps the agent-home variables the scanner discovers sessions through', () => {
    const env = buildAiVaultServiceEnv(
      {
        CODEX_HOME: '/home/dev/.codex',
        COPILOT_HOME: '/home/dev/.copilot',
        DEVIN_HOME: '/home/dev/.devin',
        GROK_HOME: '/home/dev/.grok',
        KIMI_CODE_HOME: '/home/dev/.kimi-code',
        OMP_CODING_AGENT_DIR: '/home/dev/.omp/agent/sessions',
        OPENCLAW_STATE_DIR: '/home/dev/.openclaw',
        PI_CODING_AGENT_DIR: '/home/dev/.pi/agent/sessions',
        PRIME_AGENT_CODING_AGENT_DIR: '/home/dev/.prime/agent',
        PRIME_AGENT_CODING_AGENT_SESSION_DIR: '/home/dev/.prime/legacy-sessions',
        PRIME_AGENT_SESSION_DIR: '/home/dev/.prime/sessions'
      },
      'linux'
    )

    expect(env).toEqual({
      CODEX_HOME: '/home/dev/.codex',
      COPILOT_HOME: '/home/dev/.copilot',
      DEVIN_HOME: '/home/dev/.devin',
      GROK_HOME: '/home/dev/.grok',
      KIMI_CODE_HOME: '/home/dev/.kimi-code',
      OMP_CODING_AGENT_DIR: '/home/dev/.omp/agent/sessions',
      OPENCLAW_STATE_DIR: '/home/dev/.openclaw',
      PI_CODING_AGENT_DIR: '/home/dev/.pi/agent/sessions',
      PRIME_AGENT_CODING_AGENT_DIR: '/home/dev/.prime/agent',
      PRIME_AGENT_CODING_AGENT_SESSION_DIR: '/home/dev/.prime/legacy-sessions',
      PRIME_AGENT_SESSION_DIR: '/home/dev/.prime/sessions',
      ELECTRON_RUN_AS_NODE: '1'
    })
  })

  it('keeps the OpenCode data-directory and database overrides', () => {
    const env = buildAiVaultServiceEnv(
      { XDG_DATA_HOME: '/home/dev/data', OPENCODE_DB: 'opencode-alt.db' },
      'linux'
    )

    expect(env.XDG_DATA_HOME).toBe('/home/dev/data')
    expect(env.OPENCODE_DB).toBe('opencode-alt.db')
  })

  it('runs the forked Electron binary as plain Node', () => {
    expect(buildAiVaultServiceEnv({}, 'linux').ELECTRON_RUN_AS_NODE).toBe('1')
  })

  it('ignores a POSIX variable that only matches an allowed name by case', () => {
    expect(buildAiVaultServiceEnv({ codex_home: '/tmp/spoof' }, 'linux')).toEqual({
      ELECTRON_RUN_AS_NODE: '1'
    })
  })

  it('resolves a lowercased Windows variable the OS would still honour', () => {
    const env = buildAiVaultServiceEnv({ codex_home: 'C:\\codex', Path: 'C:\\bin' }, 'win32')

    expect(env.CODEX_HOME).toBe('C:\\codex')
    expect(env.PATH).toBe('C:\\bin')
  })

  it('spells SystemRoot the way Windows Node expects', () => {
    expect(buildAiVaultServiceEnv({ SystemRoot: 'C:\\Windows' }, 'win32').SystemRoot).toBe(
      'C:\\Windows'
    )
  })

  it('does not mutate the caller environment', () => {
    const baseEnv = { NODE_OPTIONS: '--inspect', HOME: '/home/dev' }
    buildAiVaultServiceEnv(baseEnv, 'linux')

    expect(baseEnv.NODE_OPTIONS).toBe('--inspect')
  })
})

describe('buildRelayAiVaultServiceEnv', () => {
  it('drops Node flag injection variables', () => {
    const env = buildRelayAiVaultServiceEnv(
      { NODE_OPTIONS: '--max-old-space-size=8192', NODE_PATH: '/tmp/evil', HOME: '/home/ada' },
      'linux'
    )

    expect(env.NODE_OPTIONS).toBeUndefined()
    expect(env.NODE_PATH).toBeUndefined()
    expect(env.HOME).toBe('/home/ada')
  })

  // The sidecar takes remoteHome and hostPlatform from its init message, so an
  // agent-home override on the remote host is not part of how it finds roots.
  it('withholds the agent-home variables the desktop child needs', () => {
    const env = buildRelayAiVaultServiceEnv(
      { CODEX_HOME: '/remote/.codex', PATH: '/usr/bin' },
      'linux'
    )

    expect(env.CODEX_HOME).toBeUndefined()
    expect(env.PATH).toBe('/usr/bin')
  })

  it('stays plain Node rather than an Electron child', () => {
    expect(buildRelayAiVaultServiceEnv({}, 'linux').ELECTRON_RUN_AS_NODE).toBeUndefined()
  })
})
