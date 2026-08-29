import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { delimiter, join } from 'node:path'
import type * as CodexCliCommandModule from '../shared/node-cli-command-resolution'
import { WINDOWS_BATCH_UNSAFE_CHARACTERS_LABEL } from '../shared/windows-batch-spawn'

const {
  detectCommandsMock,
  guideModuleLoadMock,
  resolveCliCommandMock,
  runtimeClientConstructorMock,
  spawnMock
} = vi.hoisted(() => ({
  detectCommandsMock: vi.fn(() => new Set<string>(['claude'])),
  guideModuleLoadMock: vi.fn(),
  resolveCliCommandMock: vi.fn(() => 'npx'),
  runtimeClientConstructorMock: vi.fn(),
  spawnMock: vi.fn()
}))

// Why: agent detection probes the real machine, so pin it or every install
// assertion depends on what the test runner happens to have installed.
vi.mock('../shared/local-agent-install-dir-detection', () => ({
  detectCommandsInInstallDirs: detectCommandsMock
}))

// Why: override only the npx lookup so the real Windows .cmd rail still runs.
vi.mock('../shared/node-cli-command-resolution', async (importOriginal) => ({
  ...(await importOriginal<typeof CodexCliCommandModule>()),
  resolveCliCommand: resolveCliCommandMock
}))

vi.mock('node:child_process', () => ({
  spawn: spawnMock
}))

vi.mock('./bundled-skill-guides.js', () => {
  guideModuleLoadMock()
  return {
    BUNDLED_SKILL_GUIDES: [
      {
        name: 'zeta',
        description: 'Use when zeta work\nspans lines.',
        markdown: '# Zeta\n',
        fullMarkdown: '# Zeta\n\n## References\n\nZeta reference.\n',
        aliases: []
      },
      {
        name: 'alpha',
        description: 'Use when alpha work is needed.',
        markdown: '# Alpha\n\nShort.\n',
        fullMarkdown: '# Alpha\n\nShort.\n\n## References\n\nFull.\n',
        aliases: ['legacy-alpha']
      },
      {
        name: 'gamma',
        description:
          'Use when gamma work spans several sentences describing exactly how a ' +
          'coding agent should decide whether gamma applies to the current task at hand.',
        markdown: '# Gamma\n',
        fullMarkdown: '# Gamma\n\n## References\n\nGamma reference.\n',
        aliases: []
      }
    ]
  }
})

vi.mock('./runtime-client', async () => {
  // Why: re-export the REAL error classes rather than redefining them. format.ts
  // narrows with `instanceof` against ./runtime/types, so a look-alike class
  // here would make every CLI error fall through to the generic `runtime_error`
  // shape — mirroring the barrel keeps the mock faithful to production.
  const { RuntimeClientError, RuntimeRpcFailureError } = await import('./runtime/types.js')

  class RuntimeClient {
    constructor() {
      runtimeClientConstructorMock()
    }
  }

  return {
    RuntimeClient,
    RuntimeClientError,
    RuntimeRpcFailureError,
    serveOrcaApp: vi.fn(),
    getDefaultUserDataPath: vi.fn(() => '/tmp/orca-user-data')
  }
})

import { dispatch } from './dispatch'
import { main } from './index'

describe('orca skills CLI', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    runtimeClientConstructorMock.mockClear()
    resolveCliCommandMock.mockReset()
    resolveCliCommandMock.mockReturnValue('npx')
    detectCommandsMock.mockReset()
    detectCommandsMock.mockReturnValue(new Set<string>(['claude']))
    spawnMock.mockReset()
    process.exitCode = undefined
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  it('keeps the bundled table off the eager command-registry path', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})

    expect(guideModuleLoadMock).not.toHaveBeenCalled()
    await main(['status', '--help'], '/tmp/repo')
    expect(guideModuleLoadMock).not.toHaveBeenCalled()
  })

  it('dispatches an alias locally and emits the exact Markdown', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    await dispatch(['skills', 'get'], {
      flags: new Map([['topic', 'legacy-alpha']]),
      get client(): never {
        throw new Error('skills get accessed RuntimeClient')
      },
      cwd: '/tmp/repo',
      json: false
    })

    expect(stdoutText(stdoutSpy)).toBe('# Alpha\n\nShort.\n')
  })

  it('lists canonical topics deterministically without constructing RuntimeClient', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    await main(['skills', 'list'], '/tmp/repo')

    expect(stdoutText(stdoutSpy)).toBe(
      'alpha: Use when alpha work is needed.\n' +
        'gamma: Use when gamma work spans several sentences describing exactly how a ' +
        'coding agent should decide whether gamma applies to the current task at hand.\n' +
        'zeta: Use when zeta work spans lines.\n'
    )
    expect(runtimeClientConstructorMock).not.toHaveBeenCalled()
  })

  it('emits full Markdown for --full', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    await main(['skills', 'get', 'alpha', '--full'], '/tmp/repo')

    expect(stdoutText(stdoutSpy)).toBe('# Alpha\n\nShort.\n\n## References\n\nFull.\n')
  })

  it('supports the canonical single-item show verb as an alias', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    await main(['skills', 'show', 'alpha'], '/tmp/repo')

    expect(stdoutText(stdoutSpy)).toBe('# Alpha\n\nShort.\n')
  })

  it('gives list --json a stable canonical schema', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    await main(['skills', 'list', '--json'], '/tmp/repo')

    expect(stdoutText(stdoutSpy)).toBe(
      `${JSON.stringify(
        {
          topics: [
            { name: 'alpha', description: 'Use when alpha work is needed.' },
            {
              name: 'gamma',
              description:
                'Use when gamma work spans several sentences describing exactly how a ' +
                'coding agent should decide whether gamma applies to the current task at hand.'
            },
            { name: 'zeta', description: 'Use when zeta work spans lines.' }
          ]
        },
        null,
        2
      )}\n`
    )
  })

  it('gives alias get --json the canonical name, selection, and Markdown', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    await main(['skills', 'get', 'legacy-alpha', '--full', '--json'], '/tmp/repo')

    expect(stdoutText(stdoutSpy)).toBe(
      `${JSON.stringify(
        {
          name: 'alpha',
          full: true,
          markdown: '# Alpha\n\nShort.\n\n## References\n\nFull.\n'
        },
        null,
        2
      )}\n`
    )
  })

  it('shows leaf, group, and root help for skills', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['skills', 'get', '--help'], '/tmp/repo')
    await main(['skills', '--help'], '/tmp/repo')
    await main(['--help'], '/tmp/repo')

    expect(String(logSpy.mock.calls[0]?.[0])).toContain(
      'Usage: orca skills get <topic> [--full] [--json]'
    )
    expect(String(logSpy.mock.calls[1]?.[0])).toContain(
      'Commands:\n  installed          List installed skill selectors'
    )
    expect(String(logSpy.mock.calls[1]?.[0])).toContain(
      'get                Print a version-matched skill guide'
    )
    expect(String(logSpy.mock.calls[1]?.[0])).toContain(
      'install            Install bundled Orca skills'
    )
    expect(String(logSpy.mock.calls[1]?.[0])).toContain(
      'update             Update already-installed Orca skills'
    )
    expect(String(logSpy.mock.calls[2]?.[0])).toContain('Skills:\n  skills installed')
    expect(String(logSpy.mock.calls[2]?.[0])).toContain('skills update')
    expect(runtimeClientConstructorMock).not.toHaveBeenCalled()
  })

  it('returns a nonzero error with all canonical topics for an unknown topic', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(['skills', 'get', 'missing'], '/tmp/repo')

    expect(process.exitCode).toBe(1)
    expect(errorSpy).toHaveBeenCalledWith(
      'Unknown skill topic "missing". Available topics: alpha, gamma, zeta'
    )
    expect(runtimeClientConstructorMock).not.toHaveBeenCalled()
  })

  it('lists installable skills when no --skill/--all is given', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    await main(['skills', 'install'], '/tmp/repo')

    expect(stdoutText(stdoutSpy)).toBe(
      [
        'Choose one or more skills to install:',
        '  alpha',
        '  gamma',
        '  zeta',
        '',
        'Usage: orca skills install --skill <name> [--skill <name> ...]',
        '   or: orca skills install --all',
        ''
      ].join('\n')
    )
    expect(spawnMock).not.toHaveBeenCalled()
    expect(runtimeClientConstructorMock).not.toHaveBeenCalled()
  })

  it('gives install --json (no selection) a stable schema', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    await main(['skills', 'install', '--json'], '/tmp/repo')

    expect(stdoutText(stdoutSpy)).toBe(
      `${JSON.stringify({ availableSkills: ['alpha', 'gamma', 'zeta'] }, null, 2)}\n`
    )
  })

  it('rejects combining --all with --skill', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(['skills', 'install', '--all', '--skill', 'alpha'], '/tmp/repo')

    expect(process.exitCode).toBe(1)
    expect(errorSpy).toHaveBeenCalledWith('Use either --all or --skill, not both.')
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('rejects an unknown --skill name', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(['skills', 'install', '--skill', 'missing'], '/tmp/repo')

    expect(process.exitCode).toBe(1)
    expect(errorSpy).toHaveBeenCalledWith(
      'Unknown skill "missing". Available skills: alpha, gamma, zeta'
    )
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('rejects --skill without a value', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(['skills', 'install', '--skill'], '/tmp/repo')

    expect(process.exitCode).toBe(1)
    expect(errorSpy).toHaveBeenCalledWith('Missing required --skill')
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('rejects --json for a real (non-dry-run) install', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['skills', 'install', '--skill', 'alpha', '--json'], '/tmp/repo')

    expect(process.exitCode).toBe(1)
    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify(
        {
          id: 'local',
          ok: false,
          error: {
            code: 'invalid_argument',
            message:
              "orca skills install --json only supports --dry-run. Real installs stream npx's " +
              "own output, which isn't JSON."
          },
          _meta: { runtimeId: null }
        },
        null,
        2
      )
    )
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('prints the resolved install command without running it for --dry-run', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    await main(['skills', 'install', '--skill', 'alpha', '--dry-run'], '/tmp/repo')

    expect(stdoutText(stdoutSpy)).toBe(
      'npx --yes skills add https://github.com/stablyai/orca --skill alpha --global --agent claude-code --agent universal -y\n\n' +
        'Rerun without --dry-run to install now.\n'
    )
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('gives dry-run --json a stable schema', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    await main(['skills', 'install', '--skill', 'legacy-alpha', '--dry-run', '--json'], '/tmp/repo')

    expect(stdoutText(stdoutSpy)).toBe(
      `${JSON.stringify(
        {
          command:
            'npx --yes skills add https://github.com/stablyai/orca --skill alpha --global --agent claude-code --agent universal -y',
          skills: ['alpha'],
          global: true,
          executed: false
        },
        null,
        2
      )}\n`
    )
  })

  it('drops --global for --local in the dry-run command and JSON', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    await main(['skills', 'install', '--skill', 'alpha', '--local', '--dry-run'], '/tmp/repo')

    expect(stdoutText(stdoutSpy)).toBe(
      'npx --yes skills add https://github.com/stablyai/orca --skill alpha --agent claude-code --agent universal -y\n\n' +
        'Rerun without --dry-run to install now.\n'
    )

    stdoutSpy.mockClear()
    await main(
      ['skills', 'install', '--skill', 'alpha', '--local', '--dry-run', '--json'],
      '/tmp/repo'
    )

    expect(stdoutText(stdoutSpy)).toBe(
      `${JSON.stringify(
        {
          command:
            'npx --yes skills add https://github.com/stablyai/orca --skill alpha --agent claude-code --agent universal -y',
          skills: ['alpha'],
          global: false,
          executed: false
        },
        null,
        2
      )}\n`
    )
  })

  it('runs npx without --global for --local', async () => {
    const child = createFakeChild()
    spawnMock.mockReturnValue(child)
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const resultPromise = main(['skills', 'install', '--skill', 'alpha', '--local'], '/tmp/repo')
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled())
    child.emit('exit', 0, null)
    await resultPromise

    expect(spawnMock).toHaveBeenCalledWith(
      'npx',
      [
        '--yes',
        'skills',
        'add',
        'https://github.com/stablyai/orca',
        '--skill',
        'alpha',
        '--agent',
        'claude-code',
        '--agent',
        'universal',
        '-y'
      ],
      expect.objectContaining({ stdio: 'inherit' })
    )
  })

  it('routes a resolved Windows .cmd shim through cmd.exe', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    vi.stubEnv('ComSpec', 'C:\\Windows\\System32\\cmd.exe')
    resolveCliCommandMock.mockReturnValue('C:\\Program Files\\nodejs\\npx.cmd')
    const child = createFakeChild()
    spawnMock.mockReturnValue(child)
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const resultPromise = main(['skills', 'install', '--skill', 'alpha'], '/tmp/repo')
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled())
    child.emit('exit', 0, null)
    await resultPromise

    expect(spawnMock).toHaveBeenCalledWith(
      'C:\\Windows\\System32\\cmd.exe',
      [
        '/d',
        '/c',
        'C:\\Program Files\\nodejs\\npx.cmd',
        '--yes',
        'skills',
        'add',
        'https://github.com/stablyai/orca',
        '--skill',
        'alpha',
        '--global',
        '--agent',
        'claude-code',
        '--agent',
        'universal',
        '-y'
      ],
      expect.objectContaining({ stdio: 'inherit' })
    )
  })

  it('spawns a resolved npx path directly when it is not a .cmd shim', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    resolveCliCommandMock.mockReturnValue('C:\\Program Files\\nodejs\\npx.exe')
    const child = createFakeChild()
    spawnMock.mockReturnValue(child)
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const resultPromise = main(['skills', 'install', '--skill', 'alpha'], '/tmp/repo')
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled())
    child.emit('exit', 0, null)
    await resultPromise

    // Why: an .exe shim must stay a direct spawn so a missing npx still raises
    // ENOENT on the child instead of hiding inside cmd.exe's own exit code.
    expect(spawnMock.mock.calls[0]?.[0]).toBe('C:\\Program Files\\nodejs\\npx.exe')
    expect(spawnMock.mock.calls[0]?.[1]?.[0]).toBe('--yes')
  })

  it('resolves a legacy topic alias to the canonical skill name for install', async () => {
    const child = createFakeChild()
    spawnMock.mockReturnValue(child)
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const resultPromise = main(['skills', 'install', '--skill', 'legacy-alpha'], '/tmp/repo')
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled())
    child.emit('exit', 0, null)
    await resultPromise

    expect(spawnMock).toHaveBeenCalledWith(
      'npx',
      [
        '--yes',
        'skills',
        'add',
        'https://github.com/stablyai/orca',
        '--skill',
        'alpha',
        '--global',
        '--agent',
        'claude-code',
        '--agent',
        'universal',
        '-y'
      ],
      expect.objectContaining({ stdio: 'inherit' })
    )
  })

  it('runs npx for --all and forwards its exit code', async () => {
    const child = createFakeChild()
    spawnMock.mockReturnValue(child)
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const resultPromise = main(['skills', 'install', '--all'], '/tmp/repo')
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled())
    child.emit('exit', 1, null)
    await resultPromise

    expect(spawnMock).toHaveBeenCalledWith(
      'npx',
      [
        '--yes',
        'skills',
        'add',
        'https://github.com/stablyai/orca',
        '--skill',
        'alpha',
        '--skill',
        'gamma',
        '--skill',
        'zeta',
        '--global',
        '--agent',
        'claude-code',
        '--agent',
        'universal',
        '-y'
      ],
      expect.objectContaining({ stdio: 'inherit' })
    )
    expect(process.exitCode).toBe(1)
  })

  it('propagates a spawn error as a nonzero exit', async () => {
    const child = createFakeChild()
    spawnMock.mockReturnValue(child)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const resultPromise = main(['skills', 'install', '--skill', 'alpha'], '/tmp/repo')
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled())
    child.emit('error', new Error('spawn npx ENOENT'))
    await resultPromise

    expect(process.exitCode).toBe(1)
    expect(errorSpy).toHaveBeenCalledWith(
      'Could not run npx: spawn npx ENOENT. Install Node.js and ensure npx is on PATH.'
    )
  })

  it('lists updatable skills when no --skill/--all is given', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    await main(['skills', 'update'], '/tmp/repo')

    expect(stdoutText(stdoutSpy)).toBe(
      [
        'Choose one or more skills to update:',
        '  alpha',
        '  gamma',
        '  zeta',
        '',
        'Usage: orca skills update --skill <name> [--skill <name> ...]',
        '   or: orca skills update --all',
        ''
      ].join('\n')
    )
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('prints the resolved update command without running it for --dry-run', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    await main(['skills', 'update', '--skill', 'legacy-alpha', '--dry-run'], '/tmp/repo')

    expect(stdoutText(stdoutSpy)).toBe(
      'npx --yes skills update alpha --global -y\n\nRerun without --dry-run to update now.\n'
    )
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('selects project scope for --local on update', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    await main(
      ['skills', 'update', '--skill', 'alpha', '--local', '--dry-run', '--json'],
      '/tmp/repo'
    )

    expect(stdoutText(stdoutSpy)).toBe(
      `${JSON.stringify(
        {
          command: 'npx --yes skills update alpha --project -y',
          skills: ['alpha'],
          global: false,
          executed: false
        },
        null,
        2
      )}\n`
    )
  })

  it('runs local updates with explicit project scope', async () => {
    const child = createFakeChild()
    spawnMock.mockReturnValue(child)
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const resultPromise = main(['skills', 'update', '--skill', 'alpha', '--local'], '/tmp/repo')
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled())
    child.emit('exit', 0, null)
    await resultPromise

    expect(spawnMock).toHaveBeenCalledWith(
      'npx',
      ['--yes', 'skills', 'update', 'alpha', '--project', '-y'],
      expect.objectContaining({ stdio: 'inherit' })
    )
  })

  it('refuses a real run when the shell forwards orca to the Orca host', async () => {
    vi.stubEnv('ORCA_CLI_CWD', '/home/alice/wt')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(['skills', 'install', '--skill', 'alpha'], '/tmp/repo')

    // Why: the SSH relay and WSL bridge run argv on the Orca host, so a real
    // install there would silently skip the machine the user is sitting on.
    expect(spawnMock).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain('writes to the machine that runs it')
  })

  it('refuses --dry-run through the host-forwarding shim too', async () => {
    vi.stubEnv('ORCA_CLI_CWD', '/home/alice/wt')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(['skills', 'install', '--skill', 'alpha', '--dry-run'], '/tmp/repo')

    // Why: the targets are resolved from THIS host's agents, so a command printed
    // here would name the wrong machine's agents. Point at the target instead.
    expect(spawnMock).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain('writes to the machine that runs it')
  })

  it('puts the resolved npx directory on the child PATH', async () => {
    // Why a real directory with a real sibling node: pairing only fires when the
    // node it would add actually exists, so a fictional path proves nothing.
    const npxBin = mkdtempSync(join(tmpdir(), 'orca-npx-'))
    for (const name of ['node', 'npx']) {
      writeFileSync(join(npxBin, name), '')
      chmodSync(join(npxBin, name), 0o755)
    }
    const child = createFakeChild()
    spawnMock.mockReturnValue(child)
    resolveCliCommandMock.mockReturnValue(join(npxBin, 'npx'))
    vi.stubEnv('PATH', `/usr/bin${delimiter}/bin`)
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const resultPromise = main(['skills', 'install', '--skill', 'alpha'], '/tmp/repo')
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled())
    child.emit('exit', 0, null)
    await resultPromise

    // Why: npx is an `env node` script, so an off-PATH npx exits 127 with no
    // 'error' event unless node ships alongside it on the child's PATH.
    const env = spawnMock.mock.calls[0]?.[2]?.env
    // Why: the child still needs the inherited PATH and the rest of the parent
    // environment; replacing it outright breaks git, node, HOME and npm config.
    expect(env?.PATH).toBe(`${npxBin}${delimiter}/usr/bin${delimiter}/bin`)
    expect(env?.HOME ?? env?.USERPROFILE).toBe(process.env.HOME ?? process.env.USERPROFILE)
  })

  it('leaves PATH untouched when no node ships beside the resolved npx', async () => {
    // Why: prepending a directory that has no node buys nothing and would shadow
    // the caller's own ordering for every other binary the child resolves.
    const npxBin = mkdtempSync(join(tmpdir(), 'orca-npx-bare-'))
    writeFileSync(join(npxBin, 'npx'), '')
    chmodSync(join(npxBin, 'npx'), 0o755)
    const child = createFakeChild()
    spawnMock.mockReturnValue(child)
    resolveCliCommandMock.mockReturnValue(join(npxBin, 'npx'))
    vi.stubEnv('PATH', `/usr/bin${delimiter}/bin`)
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const resultPromise = main(['skills', 'install', '--skill', 'alpha'], '/tmp/repo')
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled())
    child.emit('exit', 0, null)
    await resultPromise

    expect(spawnMock.mock.calls[0]?.[2]?.env?.PATH).toBe(`/usr/bin${delimiter}/bin`)
  })

  it('reports a Windows npx path cmd.exe would reinterpret', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    vi.stubEnv('ComSpec', 'C:\\Windows\\System32\\cmd.exe')
    resolveCliCommandMock.mockReturnValue('C:\\Users\\A&B\\npx.cmd')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    await main(['skills', 'install', '--skill', 'alpha'], '/tmp/repo')

    expect(spawnMock).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain('cmd.exe would reinterpret')
    // Why: remediation advice that names the wrong characters is unactionable.
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain(WINDOWS_BATCH_UNSAFE_CHARACTERS_LABEL)
  })

  it('runs npx from a Program Files (x86) install instead of refusing it', async () => {
    const child = createFakeChild()
    spawnMock.mockReturnValue(child)
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    vi.stubEnv('ComSpec', 'C:\\Windows\\System32\\cmd.exe')
    const npx = 'C:\\Program Files (x86)\\nodejs\\npx.cmd'
    resolveCliCommandMock.mockReturnValue(npx)
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const resultPromise = main(['skills', 'install', '--skill', 'alpha'], '/tmp/repo')
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled())
    child.emit('exit', 0, null)
    await resultPromise

    expect(spawnMock.mock.calls[0]?.[0]).toBe('C:\\Windows\\System32\\cmd.exe')
    expect(spawnMock.mock.calls[0]?.[1]?.slice(0, 3)).toEqual(['/d', '/c', npx])
  })

  it('never puts the current directory on the child PATH when npx is unresolvable', async () => {
    const child = createFakeChild()
    spawnMock.mockReturnValue(child)
    // Why: resolveCliCommand returns the bare name when it finds nothing, and
    // dirname('npx') is '.', which would run ./npx out of the caller's checkout.
    resolveCliCommandMock.mockReturnValue('npx')
    vi.stubEnv('PATH', `/usr/bin${delimiter}/bin`)
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const resultPromise = main(['skills', 'install', '--skill', 'alpha'], '/tmp/repo')
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled())
    child.emit('exit', 0, null)
    await resultPromise

    // Why: assert the constructed value, not the ambient one — a dev PATH with a
    // trailing separator carries its own '' entry and would fake a failure here.
    expect(spawnMock.mock.calls[0]?.[2]?.env?.PATH).toBe(`/usr/bin${delimiter}/bin`)
  })

  it('refuses to install when Orca detects no agent, instead of targeting them all', async () => {
    detectCommandsMock.mockReturnValue(new Set<string>())
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(['skills', 'install', '--skill', 'alpha'], '/tmp/repo')

    // Why: `skills add -y` with nothing detected installs into every agent it
    // knows (~75), creating config dirs for agents the host does not have.
    expect(spawnMock).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain('No coding agent detected')
  })

  it('honours an explicit --agent list without probing the host', async () => {
    const child = createFakeChild()
    spawnMock.mockReturnValue(child)
    detectCommandsMock.mockReturnValue(new Set<string>())
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const resultPromise = main(
      ['skills', 'install', '--skill', 'alpha', '--agent', 'codex, claude-code ,codex'],
      '/tmp/repo'
    )
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled())
    child.emit('exit', 0, null)
    await resultPromise

    const argv = spawnMock.mock.calls[0]?.[1] ?? []
    const agents = argv.filter((_: string, i: number) => argv[i - 1] === '--agent')
    // Why: trimmed and de-duplicated, and detection is not consulted at all.
    expect(agents).toEqual(['codex', 'claude-code'])
    expect(detectCommandsMock).not.toHaveBeenCalled()
  })

  it('maps detected agents onto the skills CLI namespace, not Orca ids', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    detectCommandsMock.mockReturnValue(new Set<string>(['claude', 'cursor-agent', 'rovo']))

    await main(['skills', 'install', '--skill', 'alpha', '--dry-run'], '/tmp/repo')

    // Why: `skills add` exits 1 on an unknown --agent, and the ids differ —
    // Orca's `claude` is `claude-code` and its `rovo` is `rovodev`.
    expect(stdoutText(stdoutSpy)).toContain(
      '--agent claude-code --agent cursor --agent rovodev --agent universal'
    )
  })

  it('never sends --agent for an update, and never refuses on a bare host', async () => {
    const child = createFakeChild()
    spawnMock.mockReturnValue(child)
    // Why: update refreshes what is already placed, so the no-agent refusal that
    // guards install must not reach it.
    detectCommandsMock.mockReturnValue(new Set<string>())
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const resultPromise = main(['skills', 'update', '--skill', 'alpha'], '/tmp/repo')
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled())
    child.emit('exit', 0, null)
    await resultPromise

    // Why: update refreshes what is already placed; it chooses no new targets.
    expect(spawnMock.mock.calls[0]?.[1]).not.toContain('--agent')
  })

  it.each([
    ['a bare --agent', ['skills', 'install', '--skill', 'alpha', '--agent']],
    ['an empty --agent', ['skills', 'install', '--skill', 'alpha', '--agent', '']],
    ['a separator-only --agent', ['skills', 'install', '--skill', 'alpha', '--agent', ' , ,']]
  ])('rejects %s instead of installing to every agent', async (_label, argv) => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(argv, '/tmp/repo')

    // Why: an --agent that resolves to nothing must not fall back to detection or
    // emit no --agent at all — the latter restores the ~75-agent install.
    expect(spawnMock).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain('Missing required --agent')
  })

  it.each([
    ['a dash-leading value', ['skills', 'install', '--skill', 'alpha', '--agent', '-y']],
    ['an inline dash value', ['skills', 'install', '--skill', 'alpha', '--agent=--copy']],
    ['a value with a space', ['skills', 'install', '--skill', 'alpha', '--agent', 'a b']]
  ])('rejects %s the skills CLI would silently drop', async (_label, argv) => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(argv, '/tmp/repo')

    // Why: the skills CLI drops such a value, leaving it with no target — the same
    // all-agents install as omitting --agent entirely.
    expect(spawnMock).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain('Invalid --agent value')
  })

  it('reports forwarding, not missing agents, when a forwarded host detects none', async () => {
    vi.stubEnv('ORCA_CLI_CWD', '/home/alice/wt')
    detectCommandsMock.mockReturnValue(new Set<string>())
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(['skills', 'install', '--skill', 'alpha'], '/tmp/repo')

    // Why: resolving targets first would hide the forwarding problem behind a
    // no-agent error about the wrong machine.
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain('writes to the machine that runs it')
  })

  it('documents --agent for skills install rather than the terminal-launch flag', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['skills', 'install', '--help'], '/tmp/repo')

    const help = String(logSpy.mock.calls[0]?.[0])
    expect(help).toContain('--agent <names>')
    expect(help).not.toContain('Launch a known TUI agent')
  })

  it('accumulates a repeated --skill instead of keeping only the last one', async () => {
    const child = createFakeChild()
    spawnMock.mockReturnValue(child)
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const resultPromise = main(
      ['skills', 'install', '--skill', 'zeta', '--skill', 'alpha'],
      '/tmp/repo'
    )
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled())
    child.emit('exit', 0, null)
    await resultPromise

    // Why: the documented primary invocation. Dropping 'skill' from the
    // repeatable-flag set silently installs one skill instead of two.
    expect(spawnMock).toHaveBeenCalledWith(
      'npx',
      [
        '--yes',
        'skills',
        'add',
        'https://github.com/stablyai/orca',
        '--skill',
        'alpha',
        '--skill',
        'zeta',
        '--global',
        '--agent',
        'claude-code',
        '--agent',
        'universal',
        '-y'
      ],
      expect.objectContaining({ stdio: 'inherit' })
    )
  })

  it('collapses an alias and its canonical name into one --skill', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    await main(
      ['skills', 'install', '--skill', 'alpha', '--skill', 'legacy-alpha', '--dry-run'],
      '/tmp/repo'
    )

    expect(stdoutText(stdoutSpy)).toBe(
      'npx --yes skills add https://github.com/stablyai/orca --skill alpha --global --agent claude-code --agent universal -y\n\n' +
        'Rerun without --dry-run to install now.\n'
    )
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('reports the command it is about to run on stderr', async () => {
    const child = createFakeChild()
    spawnMock.mockReturnValue(child)
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const resultPromise = main(['skills', 'install', '--skill', 'alpha'], '/tmp/repo')
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled())
    child.emit('exit', 0, null)
    await resultPromise

    // Why: stdout belongs to the child, so this record has to go to stderr.
    expect(stderrSpy).toHaveBeenCalledWith(
      'Running: npx --yes skills add https://github.com/stablyai/orca --skill alpha --global --agent claude-code --agent universal -y\n'
    )
  })

  it('runs npx skills update for --all and forwards its exit code', async () => {
    const child = createFakeChild()
    spawnMock.mockReturnValue(child)
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const resultPromise = main(['skills', 'update', '--all'], '/tmp/repo')
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled())
    child.emit('exit', 2, null)
    await resultPromise

    expect(spawnMock).toHaveBeenCalledWith(
      'npx',
      ['--yes', 'skills', 'update', 'alpha', 'gamma', 'zeta', '--global', '-y'],
      expect.objectContaining({ stdio: 'inherit' })
    )
    expect(process.exitCode).toBe(2)
  })

  it('rejects --json for a real (non-dry-run) update', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['skills', 'update', '--skill', 'alpha', '--json'], '/tmp/repo')

    expect(process.exitCode).toBe(1)
    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify(
        {
          id: 'local',
          ok: false,
          error: {
            code: 'invalid_argument',
            message:
              "orca skills update --json only supports --dry-run. Real updates stream npx's " +
              "own output, which isn't JSON."
          },
          _meta: { runtimeId: null }
        },
        null,
        2
      )
    )
    expect(spawnMock).not.toHaveBeenCalled()
  })
})

function stdoutText(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.map((call) => String(call[0])).join('')
}

function createFakeChild(): EventEmitter {
  return new EventEmitter()
}
