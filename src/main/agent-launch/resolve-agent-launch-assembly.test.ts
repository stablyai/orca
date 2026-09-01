import { describe, expect, it } from 'vitest'
import type { CustomTuiAgentId } from '../../shared/types'
import type {
  AgentLaunchExecutionHostId,
  ResolveAgentLaunchRequest
} from '../../shared/agent-launch-host-contract'
import { TUI_AGENT_CONFIG } from '../../shared/tui-agent-config'
import { resolveAgentLaunch, type ResolveAgentLaunchOutcome } from './resolve-agent-launch'
import { assembleCommand } from './resolve-agent-command'
import {
  catalogOf,
  customAgent,
  customId,
  requestOf,
  settingsOf
} from './agent-launch-test-catalog'

function argvOf(outcome: ResolveAgentLaunchOutcome): string[] {
  if (!outcome.ok) {
    throw new Error(`expected launch, got ${JSON.stringify(outcome)}`)
  }
  return [...outcome.launch.argv]
}

function failureOf(outcome: ResolveAgentLaunchOutcome): {
  code: string
  reason?: string
  variable?: string
  shell?: string
} {
  if (outcome.ok || !('failure' in outcome)) {
    throw new Error(`expected a launch failure, got ${JSON.stringify(outcome)}`)
  }
  return outcome.failure
}

const CID: CustomTuiAgentId = customId('claude', '00000000-0000-4000-8000-0000000000c1')

/** Resolve a launch for a live custom agent built from `overrides`. */
function resolveCustom(
  overrides: Partial<Parameters<typeof customAgent>[0]>,
  request: Partial<ResolveAgentLaunchRequest> = {}
): ResolveAgentLaunchOutcome {
  const agent = customAgent({ id: CID, ...overrides })
  return resolveAgentLaunch(
    requestOf({ selection: { kind: 'agent', agent: CID }, ...request }),
    catalogOf({ customTuiAgents: [agent] }),
    settingsOf()
  )
}

describe('command override assembly', () => {
  it('keeps an executable path with spaces as one argv element', () => {
    const outcome = resolveCustom({ commandOverride: '/opt/my agent/bin/run' })
    expect(argvOf(outcome)).toEqual(['/opt/my agent/bin/run'])
  })

  it('keeps ordinary metacharacters as data on posix', () => {
    const outcome = resolveCustom({ commandOverride: '/opt/a&b/run' })
    expect(argvOf(outcome)).toEqual(['/opt/a&b/run'])
  })

  it('interpolates repoPath into the override as one element even with spaces', () => {
    const outcome = resolveCustom(
      { commandOverride: '{repoPath}/bin/run' },
      { variables: { repoPath: '/work spaces/repo' } }
    )
    expect(argvOf(outcome)).toEqual(['/work spaces/repo/bin/run'])
  })
})

describe('env value interpolation', () => {
  it('substitutes {worktreePath}/{repoPath} tokens in admitted env values', () => {
    const outcome = resolveCustom(
      {
        env: { LOG_DIR: '{worktreePath}/logs', REPO: '{repoPath}', PLAIN: 'keep' },
        syncEnv: true
      },
      { variables: { worktreePath: '/wt/x', repoPath: '/repo/y' } }
    )
    if (!outcome.ok) {
      throw new Error(`expected launch, got ${JSON.stringify(outcome)}`)
    }
    expect(outcome.launch.agentEnv).toMatchObject({
      LOG_DIR: '/wt/x/logs',
      REPO: '/repo/y',
      PLAIN: 'keep'
    })
  })

  it('still requires a variable referenced only in an env value', () => {
    const outcome = resolveCustom(
      { env: { LOG_DIR: '{worktreePath}/logs' }, syncEnv: true },
      { variables: {} }
    )
    expect(failureOf(outcome)).toMatchObject({
      code: 'missing_variable',
      variable: 'worktreePath'
    })
  })
})

describe('legacy built-in prefix', () => {
  it('rejects whitespace-delimited operator syntax as invalid_command_override', () => {
    const outcome = resolveAgentLaunch(
      requestOf({ selection: { kind: 'agent', agent: 'claude' } }),
      catalogOf({}),
      settingsOf({ agentCmdOverrides: { claude: 'claude && rm' } })
    )
    expect(failureOf(outcome)).toMatchObject({
      code: 'invalid_command_override',
      reason: 'shell_operator'
    })
  })

  it('tokenizes a multi-token wrapper prefix into structured argv', () => {
    const outcome = resolveAgentLaunch(
      requestOf({ selection: { kind: 'agent', agent: 'claude' } }),
      catalogOf({}),
      settingsOf({
        agentCmdOverrides: { claude: 'nice -n 10 claude' },
        agentDefaultArgs: { claude: '' }
      })
    )
    expect(argvOf(outcome)).toEqual(['nice', '-n', '10', 'claude'])
  })
})

describe('tilde expansion', () => {
  it('expands ~/ from posix target home', () => {
    const outcome = resolveCustom(
      { commandOverride: '~/bin/agent' },
      { targetHomePath: '/home/dev' }
    )
    expect(argvOf(outcome)).toEqual(['/home/dev/bin/agent'])
  })

  it('expands bare ~ to the target home', () => {
    const outcome = resolveCustom({ commandOverride: '~' }, { targetHomePath: '/home/dev' })
    expect(argvOf(outcome)).toEqual(['/home/dev'])
  })

  it('expands ~\\ on a windows powershell target', () => {
    const outcome = resolveCustom(
      { commandOverride: '~\\bin\\agent.exe' },
      { platform: 'win32', shell: 'powershell', targetHomePath: 'C:\\Users\\me' }
    )
    expect(argvOf(outcome)).toEqual(['C:\\Users\\me\\bin\\agent.exe'])
  })

  it('rejects ~user/ forms with tilde_user', () => {
    const outcome = resolveCustom(
      { commandOverride: '~alice/bin/agent' },
      { targetHomePath: '/home/dev' }
    )
    expect(failureOf(outcome)).toMatchObject({
      code: 'invalid_command_override',
      reason: 'tilde_user'
    })
  })

  it('defers ~ to the target shell when home is unavailable', () => {
    // SSH/remote: hard-failing here also aborts worktree creation, and only the
    // target shell knows its own home.
    const outcome = resolveCustom({ commandOverride: '~/bin/agent' }, { targetHomePath: null })
    expect(argvOf(outcome)).toEqual(['~/bin/agent'])
  })

  it('defers a ~-prefixed WSL executable with no distro home to the target shell', () => {
    const outcome = resolveCustom(
      { commandOverride: '~/bin/agent' },
      {
        platform: 'linux',
        shell: 'posix',
        executionHostId: 'wsl:Ubuntu' as AgentLaunchExecutionHostId,
        targetHomePath: null
      }
    )
    expect(argvOf(outcome)).toEqual(['~/bin/agent'])
  })

  it('still fails missing_target_home when the deferred form is not shell-safe', () => {
    // A space cannot survive an unquoted emission, so there is nothing to defer.
    const outcome = resolveCustom({ commandOverride: '~/my bin/agent' }, { targetHomePath: null })
    expect(failureOf(outcome).code).toBe('missing_target_home')
  })

  it('still fails missing_target_home on a windows target, which has no deferral', () => {
    const outcome = resolveCustom(
      { commandOverride: '~\\bin\\agent.exe' },
      { platform: 'win32', shell: 'powershell', targetHomePath: null }
    )
    expect(failureOf(outcome).code).toBe('missing_target_home')
  })
})

describe('custom args grammar', () => {
  it('groups quoted tokens and keeps a spaced value as one element', () => {
    const outcome = resolveCustom({ commandOverride: '/bin/agent', args: '"a b" c' })
    expect(argvOf(outcome)).toEqual(['/bin/agent', 'a b', 'c'])
  })

  it('retains an empty quoted token', () => {
    const outcome = resolveCustom({ commandOverride: '/bin/agent', args: '"" x' })
    expect(argvOf(outcome)).toEqual(['/bin/agent', '', 'x'])
  })

  it('preserves literal windows backslashes and a trailing backslash', () => {
    const outcome = resolveCustom({ commandOverride: '/bin/agent', args: 'C:\\Users\\me\\' })
    expect(argvOf(outcome)).toEqual(['/bin/agent', 'C:\\Users\\me\\'])
  })

  it('keeps = inside a single argument', () => {
    const outcome = resolveCustom({ commandOverride: '/bin/agent', args: 'FOO=bar' })
    expect(argvOf(outcome)).toEqual(['/bin/agent', 'FOO=bar'])
  })

  it('keeps a repoPath value with spaces as one argv element', () => {
    const outcome = resolveCustom(
      { commandOverride: '/bin/agent', args: '{repoPath}' },
      { variables: { repoPath: '/a b/c' } }
    )
    expect(argvOf(outcome)).toEqual(['/bin/agent', '/a b/c'])
  })

  it('keeps a cmd-metachar-free arg containing % as data on posix', () => {
    const outcome = resolveCustom({ commandOverride: '/bin/agent', args: '--pct 50%' })
    expect(argvOf(outcome)).toEqual(['/bin/agent', '--pct', '50%'])
  })
})

describe('per-launch recipe args band (U7)', () => {
  it('appends recipe args as a distinct band after the definition argv', () => {
    const outcome = resolveCustom(
      { commandOverride: '/bin/agent', args: '--def one' },
      { perLaunchArgs: '--recipe two' }
    )
    expect(argvOf(outcome)).toEqual(['/bin/agent', '--def', 'one', '--recipe', 'two'])
  })

  it('tokenizes recipe args through the v1 grammar (quoted value is one element)', () => {
    const outcome = resolveCustom({ commandOverride: '/bin/agent' }, { perLaunchArgs: '"a b" c' })
    expect(argvOf(outcome)).toEqual(['/bin/agent', 'a b', 'c'])
  })

  it('interpolates a variable referenced only in recipe args and keeps spaces intact', () => {
    const outcome = resolveCustom(
      { commandOverride: '/bin/agent' },
      { perLaunchArgs: '{worktreePath}', variables: { worktreePath: '/w s/t' } }
    )
    expect(argvOf(outcome)).toEqual(['/bin/agent', '/w s/t'])
  })

  it('requires a variable referenced only in recipe args', () => {
    const outcome = resolveCustom(
      { commandOverride: '/bin/agent' },
      { perLaunchArgs: '{worktreePath}', variables: {} }
    )
    expect(failureOf(outcome)).toMatchObject({ code: 'missing_variable', variable: 'worktreePath' })
  })
})

// The catalog pre-validates a live definition, so quoted-line-break/control args
// never reach the resolver as a live agent — they become repair-required. Exercise
// the resolver's defensive re-tokenization directly for persisted/remote data.
describe('assembleCommand defensive re-validation', () => {
  const base = {
    config: TUI_AGENT_CONFIG.claude,
    platform: 'linux' as NodeJS.Platform,
    isRemote: false,
    shell: 'posix' as const,
    targetHomePath: '/home/dev',
    prefixOverride: null,
    envValues: [] as string[],
    values: { repoPath: null, worktreePath: null }
  }

  it('rejects a quoted line break in custom args', () => {
    const result = assembleCommand({
      ...base,
      commandOverride: '/bin/agent',
      argsTemplate: '"a\nb"',
      isCustomArgs: true
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.failure).toMatchObject({
        code: 'invalid_agent_args',
        reason: 'quoted_line_break'
      })
    }
  })

  it('rejects a cmd-metachar custom args token', () => {
    const result = assembleCommand({
      ...base,
      shell: 'cmd',
      commandOverride: 'C:\\bin\\agent.exe',
      argsTemplate: '--x a%b',
      isCustomArgs: true
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.failure).toMatchObject({
        code: 'invalid_agent_args',
        reason: 'cmd_metachar',
        shell: 'cmd'
      })
    }
  })

  it('rejects a quoted line break in recipe args with the same diagnostics as definition args', () => {
    const result = assembleCommand({
      ...base,
      commandOverride: '/bin/agent',
      argsTemplate: '--def',
      isCustomArgs: true,
      perLaunchArgs: '"a\nb"'
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.failure).toMatchObject({
        code: 'invalid_agent_args',
        field: 'args',
        reason: 'quoted_line_break'
      })
    }
  })

  it('rejects a cmd-metachar recipe args token even when definition args are built-in', () => {
    const result = assembleCommand({
      ...base,
      shell: 'cmd',
      commandOverride: 'C:\\bin\\agent.exe',
      argsTemplate: '--def',
      isCustomArgs: false,
      perLaunchArgs: '--x a%b'
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.failure).toMatchObject({
        code: 'invalid_agent_args',
        reason: 'cmd_metachar',
        shell: 'cmd'
      })
    }
  })
})

describe('missing variables', () => {
  it('reports the first missing variable in deterministic order with no partial output', () => {
    const outcome = resolveCustom(
      { commandOverride: '/bin/agent', args: '{repoPath} {worktreePath}' },
      { variables: { worktreePath: '/wt' } }
    )
    expect(failureOf(outcome)).toMatchObject({ code: 'missing_variable', variable: 'repoPath' })
  })

  it('treats an empty-string variable value as missing', () => {
    const outcome = resolveCustom(
      { commandOverride: '/bin/agent', args: '{worktreePath}' },
      { variables: { worktreePath: '' } }
    )
    expect(failureOf(outcome)).toMatchObject({ code: 'missing_variable', variable: 'worktreePath' })
  })
})

describe('detection gate', () => {
  const detectedWithoutClaude = new Set<never>() as ReadonlySet<'claude'>

  it('fails base_agent_unavailable for stock argv when the base is not detected', () => {
    const outcome = resolveAgentLaunch(
      requestOf({
        selection: { kind: 'agent', agent: 'claude' },
        detectedStockBaseAgents: detectedWithoutClaude
      }),
      catalogOf({}),
      settingsOf()
    )
    expect(failureOf(outcome).code).toBe('base_agent_unavailable')
  })

  it('bypasses detection for a configured built-in prefix', () => {
    const outcome = resolveAgentLaunch(
      requestOf({
        selection: { kind: 'agent', agent: 'claude' },
        detectedStockBaseAgents: detectedWithoutClaude
      }),
      catalogOf({}),
      settingsOf({ agentCmdOverrides: { claude: '/opt/claude' }, agentDefaultArgs: { claude: '' } })
    )
    expect(argvOf(outcome)).toEqual(['/opt/claude'])
  })

  it('bypasses detection for a custom executable override', () => {
    const outcome = resolveCustom(
      { commandOverride: '/opt/claude' },
      { detectedStockBaseAgents: detectedWithoutClaude }
    )
    expect(argvOf(outcome)).toEqual(['/opt/claude'])
  })

  it('bypasses detection when custom env supplies a PATH override', () => {
    const outcome = resolveCustom(
      { env: { PATH: '/opt/bin' } },
      { detectedStockBaseAgents: detectedWithoutClaude }
    )
    expect(argvOf(outcome)).toEqual(['claude'])
  })

  it('fails base_agent_unavailable for a safe fallback whose stock base is not detected', () => {
    const outcome = resolveAgentLaunch(
      requestOf({
        selection: { kind: 'agent', agent: CID },
        intent: { kind: 'interactive', client: 'desktop' },
        reference: { kind: 'persisted', owner: 'default' },
        detectedStockBaseAgents: detectedWithoutClaude
      }),
      catalogOf({ customTuiAgents: [customAgent({ id: CID })], disabledTuiAgents: [CID] }),
      settingsOf()
    )
    expect(failureOf(outcome).code).toBe('base_agent_unavailable')
  })
})

describe('fixed catalog subcommands', () => {
  const cases: [string, string[]][] = [
    ['kiro', ['kiro-cli', 'chat', '--tui']],
    ['command-code', ['command-code', '--trust']],
    ['hermes', ['hermes', '--tui']]
  ]
  for (const [agent, argv] of cases) {
    it(`${agent} launches with its fixed subcommand argv`, () => {
      const outcome = resolveAgentLaunch(
        requestOf({ selection: { kind: 'agent', agent: agent as never } }),
        catalogOf({}),
        settingsOf({ agentDefaultArgs: { [agent]: '' } as never })
      )
      expect(argvOf(outcome)).toEqual(argv)
    })
  }

  it('uses remote linux orca and local linux orca-ide for claude-agent-teams', () => {
    const remote = resolveAgentLaunch(
      requestOf({ selection: { kind: 'agent', agent: 'claude-agent-teams' }, isRemote: true }),
      catalogOf({}),
      settingsOf({ agentDefaultArgs: { 'claude-agent-teams': '' } })
    )
    expect(argvOf(remote)).toEqual(['orca', 'claude-teams'])
    const local = resolveAgentLaunch(
      requestOf({ selection: { kind: 'agent', agent: 'claude-agent-teams' }, isRemote: false }),
      catalogOf({}),
      settingsOf({ agentDefaultArgs: { 'claude-agent-teams': '' } })
    )
    expect(argvOf(local)).toEqual(['orca-ide', 'claude-teams'])
    const win = resolveAgentLaunch(
      requestOf({
        selection: { kind: 'agent', agent: 'claude-agent-teams' },
        platform: 'win32',
        shell: 'powershell'
      }),
      catalogOf({}),
      settingsOf({ agentDefaultArgs: { 'claude-agent-teams': '' } })
    )
    expect(argvOf(win)).toEqual(['orca.cmd', 'claude-teams'])
  })
})

describe('built-in default args', () => {
  it('appends configured default args as separate argv elements', () => {
    const outcome = resolveAgentLaunch(
      requestOf({ selection: { kind: 'agent', agent: 'claude' } }),
      catalogOf({}),
      settingsOf({ agentDefaultArgs: { claude: '--model sonnet' } })
    )
    expect(argvOf(outcome)).toEqual(['claude', '--model', 'sonnet'])
  })

  it('keeps backslashes literal on a windows powershell target (#7862 grammar)', () => {
    const outcome = resolveAgentLaunch(
      requestOf({
        selection: { kind: 'agent', agent: 'claude' },
        platform: 'win32',
        shell: 'powershell',
        targetHomePath: 'C:\\Users\\me'
      }),
      catalogOf({}),
      settingsOf({ agentDefaultArgs: { claude: '--config C:\\tools\\x' } })
    )
    expect(argvOf(outcome)).toEqual(['claude', '--config', 'C:\\tools\\x'])
  })

  it('keeps backslashes literal on a windows cmd target (#7862 grammar)', () => {
    const outcome = resolveAgentLaunch(
      requestOf({
        selection: { kind: 'agent', agent: 'claude' },
        platform: 'win32',
        shell: 'cmd',
        targetHomePath: 'C:\\Users\\me'
      }),
      catalogOf({}),
      settingsOf({ agentDefaultArgs: { claude: '--config C:\\tools\\x' } })
    )
    expect(argvOf(outcome)).toEqual(['claude', '--config', 'C:\\tools\\x'])
  })
})

describe('cmd fail-closed', () => {
  const cmdRequest = { platform: 'win32' as NodeJS.Platform, shell: 'cmd' as const }

  for (const char of ['%', '!', '"', '^']) {
    it(`rejects a custom override containing ${char} with cmd_metachar`, () => {
      const outcome = resolveCustom({ commandOverride: `C:\\bin\\a${char}b.exe` }, cmdRequest)
      expect(failureOf(outcome)).toMatchObject({
        code: 'invalid_agent_args',
        reason: 'cmd_metachar',
        shell: 'cmd'
      })
    })
  }

  it('lets & | < > ( ) survive as data from an interpolated path on cmd', () => {
    // A worktree path with these neutral cmd chars must reach the program intact;
    // the override validator rejects them only as literal whitespace-delimited
    // operators, so they arrive via an interpolated variable value.
    const outcome = resolveCustom(
      { commandOverride: '{repoPath}\\run.exe' },
      { ...cmdRequest, variables: { repoPath: 'C:\\Foo & Bar (x)' } }
    )
    expect(argvOf(outcome)).toEqual(['C:\\Foo & Bar (x)\\run.exe'])
  })

  it('rejects a cmd-metachar variable value on the built-in path', () => {
    const outcome = resolveAgentLaunch(
      requestOf({
        selection: { kind: 'agent', agent: 'claude' },
        ...cmdRequest,
        variables: { repoPath: 'C:\\a%b' }
      }),
      catalogOf({}),
      settingsOf({ agentDefaultArgs: { claude: '--root {repoPath}' } })
    )
    expect(failureOf(outcome)).toMatchObject({
      code: 'invalid_agent_args',
      reason: 'cmd_metachar',
      shell: 'cmd'
    })
  })
})

describe('WSL variable translation', () => {
  it('translates a drive-letter repoPath into distro form before substitution', () => {
    const outcome = resolveCustom(
      { commandOverride: '/bin/agent', args: '{repoPath}' },
      {
        platform: 'linux',
        shell: 'posix',
        executionHostId: 'wsl:Ubuntu' as AgentLaunchExecutionHostId,
        variables: { repoPath: 'C:\\repo\\app' }
      }
    )
    const launched = argvOf(outcome)
    expect(launched).toEqual(['/bin/agent', '/mnt/c/repo/app'])
    if (outcome.ok) {
      expect(outcome.launch.snapshot.target.execution).toBe('wsl')
      expect(outcome.launch.variables.values.repoPath).toBe('/mnt/c/repo/app')
    }
  })

  it('translates a \\\\wsl.localhost UNC repoPath into its linux path', () => {
    const outcome = resolveCustom(
      { commandOverride: '/bin/agent', args: '{repoPath}' },
      {
        platform: 'linux',
        shell: 'posix',
        executionHostId: 'wsl:Ubuntu' as AgentLaunchExecutionHostId,
        variables: { repoPath: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo' }
      }
    )
    expect(argvOf(outcome)).toEqual(['/bin/agent', '/home/dev/repo'])
  })
})

describe('snapshot immutability', () => {
  it('deep-freezes the snapshot and excludes prompt/process/env-control data', () => {
    const outcome = resolveCustom({ commandOverride: '/bin/agent', args: 'x' })
    if (!outcome.ok) {
      throw new Error('expected launch')
    }
    expect(Object.isFrozen(outcome.launch.snapshot)).toBe(true)
    expect(Object.isFrozen(outcome.launch.snapshot.argv)).toBe(true)
    expect(Object.keys(outcome.launch.snapshot)).toEqual([
      'version',
      'requestedAgent',
      'baseAgent',
      'displayLabel',
      'mode',
      'argv',
      'agentEnv',
      'capturedEnvPolicy',
      'target'
    ])
  })
})

describe('two-stage stable-input digest', () => {
  function resolveWithWorktree(worktreePath: string): ResolveAgentLaunchOutcome {
    return resolveAgentLaunch(
      requestOf({
        selection: { kind: 'agent', agent: 'claude' },
        variables: { repoPath: '/repo', worktreePath }
      }),
      catalogOf({}),
      settingsOf()
    )
  }

  it('stays identical across worktree paths while the admission fingerprint changes', () => {
    const first = resolveWithWorktree('/wt-a')
    const second = resolveWithWorktree('/wt-b')
    if (!first.ok || !second.ok) {
      throw new Error('expected both launches to resolve')
    }
    // The path-inclusive admission guard differs because a variable value changed.
    expect(first.launch.admissionGuard.fingerprint).not.toBe(
      second.launch.admissionGuard.fingerprint
    )
    // The config-only digest is stable, so pre-create pinning (path unknown) and
    // post-create resolution (authoritative path) recheck cleanly.
    expect(first.launch.admissionGuard.stableInputDigest).toBe(
      second.launch.admissionGuard.stableInputDigest
    )
  })
})
