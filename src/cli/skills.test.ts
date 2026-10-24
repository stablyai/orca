import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { guideModuleLoadMock, previewMock, runtimeClientConstructorMock } = vi.hoisted(() => ({
  guideModuleLoadMock: vi.fn(),
  previewMock: vi.fn(),
  runtimeClientConstructorMock: vi.fn()
}))

// Installer behavior is covered separately in skills-install.test.ts.
vi.mock('../main/skills/bundled-skill-install/cli-entry', () => ({
  localBundledSkillInput: previewMock,
  previewBundledSkillInstall: previewMock,
  installBundledSkills: previewMock
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
  // Error formatting uses instanceof, so the mock must preserve the production classes.
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
    previewMock.mockReset()
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
      'Usage: orca skills get <topic> [--full | --reference <name>] [--json]'
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
      'update             Update Orca skills to the version this Orca build ships'
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
  })

  it('rejects an unknown --skill name', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(['skills', 'install', '--skill', 'missing'], '/tmp/repo')

    expect(process.exitCode).toBe(1)
    expect(errorSpy).toHaveBeenCalledWith(
      'Unknown skill "missing". Available skills: alpha, gamma, zeta'
    )
  })

  it('rejects --skill without a value', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(['skills', 'install', '--skill'], '/tmp/repo')

    expect(process.exitCode).toBe(1)
    expect(errorSpy).toHaveBeenCalledWith('--skill requires a value; it was passed with none.')
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
  })

  it('refuses a real run when the shell forwards orca to the Orca host', async () => {
    vi.stubEnv('ORCA_CLI_CWD', '/home/alice/wt')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(['skills', 'install', '--skill', 'alpha'], '/tmp/repo')

    expect(process.exitCode).toBe(1)
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain('writes to the machine that runs it')
    expect(previewMock).not.toHaveBeenCalled()
  })

  it('refuses --dry-run through the host-forwarding shim too', async () => {
    vi.stubEnv('ORCA_CLI_CWD', '/home/alice/wt')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(['skills', 'install', '--skill', 'alpha', '--dry-run'], '/tmp/repo')

    expect(process.exitCode).toBe(1)
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain('writes to the machine that runs it')
    expect(previewMock).not.toHaveBeenCalled()
  })

  it('documents --agent for skills install rather than the terminal-launch flag', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['skills', 'install', '--help'], '/tmp/repo')

    const help = String(logSpy.mock.calls[0]?.[0])
    expect(help).toContain('--agent <names>')
    expect(help).not.toContain('Launch a known TUI agent')
  })
})

function stdoutText(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.map((call) => String(call[0])).join('')
}
