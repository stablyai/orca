import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as CodexCliCommandModule from '../shared/node-cli-command-resolution'

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

// Why: pin detection so remove assertions do not depend on the runner host.
vi.mock('../shared/local-agent-install-dir-detection', () => ({
  detectCommandsInInstallDirs: detectCommandsMock
}))

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
        description: 'Use when gamma work is needed.',
        markdown: '# Gamma\n',
        fullMarkdown: '# Gamma\n\n## References\n\nGamma reference.\n',
        aliases: []
      }
    ]
  }
})

vi.mock('./runtime-client', async () => {
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

import { main } from './index'

describe('orca skills remove CLI', () => {
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

  it('lists removable skills when no --skill/--all is given', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    await main(['skills', 'remove'], '/tmp/repo')

    expect(stdoutText(stdoutSpy)).toBe(
      [
        'Choose one or more skills to remove:',
        '  alpha',
        '  gamma',
        '  zeta',
        '',
        'Usage: orca skills remove --skill <name> [--skill <name> ...]',
        '   or: orca skills remove --all',
        ''
      ].join('\n')
    )
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('prints the resolved remove command without running it for --dry-run', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    await main(['skills', 'remove', '--skill', 'legacy-alpha', '--dry-run'], '/tmp/repo')

    expect(stdoutText(stdoutSpy)).toBe(
      'npx --yes skills remove alpha --global -y\n\nRerun without --dry-run to remove now.\n'
    )
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('omits --global for project-local remove (skills CLI default scope)', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    await main(
      ['skills', 'remove', '--skill', 'alpha', '--local', '--dry-run', '--json'],
      '/tmp/repo'
    )

    expect(stdoutText(stdoutSpy)).toBe(
      `${JSON.stringify(
        {
          command: 'npx --yes skills remove alpha -y',
          skills: ['alpha'],
          global: false,
          executed: false
        },
        null,
        2
      )}\n`
    )
  })

  it('never sends --agent for a remove, and never refuses on a bare host', async () => {
    const child = createFakeChild()
    spawnMock.mockReturnValue(child)
    // Why: remove only deletes what is already placed, so the no-agent install
    // refusal must not reach it.
    detectCommandsMock.mockReturnValue(new Set<string>())
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const resultPromise = main(['skills', 'remove', '--skill', 'alpha'], '/tmp/repo')
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled())
    child.emit('exit', 0, null)
    await resultPromise

    expect(spawnMock.mock.calls[0]?.[1]).not.toContain('--agent')
    expect(spawnMock).toHaveBeenCalledWith(
      'npx',
      ['--yes', 'skills', 'remove', 'alpha', '--global', '-y'],
      expect.objectContaining({ stdio: 'inherit' })
    )
  })

  it('runs npx skills remove for --all and forwards its exit code', async () => {
    const child = createFakeChild()
    spawnMock.mockReturnValue(child)
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const resultPromise = main(['skills', 'remove', '--all'], '/tmp/repo')
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled())
    child.emit('exit', 3, null)
    await resultPromise

    expect(spawnMock).toHaveBeenCalledWith(
      'npx',
      ['--yes', 'skills', 'remove', 'alpha', 'gamma', 'zeta', '--global', '-y'],
      expect.objectContaining({ stdio: 'inherit' })
    )
    expect(process.exitCode).toBe(3)
  })

  it('rejects --json for a real (non-dry-run) remove', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['skills', 'remove', '--skill', 'alpha', '--json'], '/tmp/repo')

    expect(process.exitCode).toBe(1)
    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify(
        {
          id: 'local',
          ok: false,
          error: {
            code: 'invalid_argument',
            message:
              "orca skills remove --json only supports --dry-run. Real removes stream npx's " +
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
