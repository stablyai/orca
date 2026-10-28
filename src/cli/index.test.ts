import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  callMock,
  runtimeClientConstructorMock,
  serveOrcaAppMock,
  getDefaultUserDataPathMock,
  addEnvironmentFromPairingCodeMock,
  listEnvironmentsMock,
  spawnMock
} = vi.hoisted(() => ({
  callMock: vi.fn(),
  runtimeClientConstructorMock: vi.fn(),
  serveOrcaAppMock: vi.fn(),
  getDefaultUserDataPathMock: vi.fn(() => '/tmp/orca-user-data'),
  addEnvironmentFromPairingCodeMock: vi.fn(),
  listEnvironmentsMock: vi.fn(),
  spawnMock: vi.fn()
}))

vi.mock('./runtime-client', async () => {
  const { createRuntimeClientModuleMock } = await import('./index-test-harness.js')
  return createRuntimeClientModuleMock({
    callMock,
    runtimeClientConstructorMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock
  })
})

vi.mock('./runtime/environments', () => ({
  addEnvironmentFromPairingCode: addEnvironmentFromPairingCodeMock,
  listEnvironments: listEnvironmentsMock,
  removeEnvironment: vi.fn(),
  resolveEnvironment: vi.fn()
}))

vi.mock('child_process', async () => {
  const { createChildProcessModuleMock } = await import('./index-test-harness.js')
  return createChildProcessModuleMock(spawnMock)
})

import { COMMAND_SPECS, main } from './index'
import { GLOBAL_FLAGS, specPaths } from './args'
import { okFixture, queueFixtures } from './test-fixtures'

describe('COMMAND_SPECS collision check', () => {
  it('has no duplicate command or alias paths', () => {
    // First-match resolution would silently shadow duplicate aliases.
    const seen = new Set<string>()
    for (const spec of COMMAND_SPECS) {
      for (const path of specPaths(spec)) {
        const key = path.join(' ')
        expect(seen.has(key), `Duplicate command/alias path: "${key}"`).toBe(false)
        seen.add(key)
      }
    }
  })

  it('allows every flag documented in command usage strings', () => {
    const flagPattern = /--([a-zA-Z0-9-]+)/g
    for (const spec of COMMAND_SPECS) {
      const allowed = new Set([...GLOBAL_FLAGS, ...spec.allowedFlags])
      for (const match of spec.usage.matchAll(flagPattern)) {
        const flag = match[1]
        expect(
          allowed.has(flag),
          `Documented flag --${flag} is not allowed for command: ${spec.path.join(' ')}`
        ).toBe(true)
      }
    }
  })
})

describe('command aliases dispatch to the canonical handler', () => {
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    callMock.mockReset()
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    callMock.mockReset()
    // Restore the spy so later describe blocks cannot inherit these calls.
    logSpy.mockRestore()
  })

  it('runs `worktree remove` as the canonical `worktree rm` (the incident)', async () => {
    queueFixtures(
      callMock,
      okFixture('req_show', { worktree: { hostId: 'local' } }),
      okFixture('req', { removed: true })
    )

    await main(['worktree', 'remove', '--worktree', 'id:wt-1', '--force', '--json'], '/tmp/repo')

    expect(callMock).toHaveBeenNthCalledWith(
      2,
      'worktree.rm',
      expect.objectContaining({ worktree: 'id:wt-1', hostId: 'local', force: true })
    )
  })

  it('runs `worktree delete` as the canonical `worktree rm`', async () => {
    queueFixtures(
      callMock,
      okFixture('req_show', { worktree: { hostId: 'runtime:env-1' } }),
      okFixture('req', { removed: true })
    )

    await main(['worktree', 'delete', '--worktree', 'id:wt-1', '--json'], '/tmp/repo')

    expect(callMock).toHaveBeenNthCalledWith(
      2,
      'worktree.rm',
      expect.objectContaining({ worktree: 'id:wt-1', hostId: 'runtime:env-1' })
    )
  })

  it('says the checkout is still being deleted when the host accepted a background removal', async () => {
    queueFixtures(
      callMock,
      okFixture('req_show', { worktree: { hostId: 'local' } }),
      okFixture('req', { removed: true, removing: true })
    )

    await main(['worktree', 'rm', '--worktree', 'id:wt-1'], '/tmp/repo')

    expect(logSpy).toHaveBeenCalledWith(
      'removed: true\nOrca is still deleting the checkout in the background.'
    )
  })

  it('fails closed when worktree removal cannot resolve a host', async () => {
    queueFixtures(callMock, okFixture('req_show', { worktree: { id: 'wt-1' } }))
    const priorExitCode = process.exitCode

    try {
      await main(['worktree', 'rm', '--worktree', 'id:wt-1', '--json'], '/tmp/repo')

      expect(process.exitCode).toBe(1)
      expect(callMock).toHaveBeenCalledTimes(1)
      expect(callMock).toHaveBeenCalledWith('worktree.show', { worktree: 'id:wt-1' })
      expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]))).toMatchObject({
        ok: false,
        error: { code: 'worktree_host_unresolved' }
      })
    } finally {
      process.exitCode = priorExitCode
    }
  })

  it('exits non-zero when worktree removal is refused by a failed archive hook', async () => {
    const { RuntimeRpcFailureError } = await import('./runtime/types.js')
    queueFixtures(callMock, okFixture('req_show', { worktree: { hostId: 'local' } }))
    callMock.mockRejectedValueOnce(
      new RuntimeRpcFailureError({
        id: 'req_archive',
        ok: false,
        error: {
          code: 'worktree_archive_hook_failed',
          message: 'Archive hook failed for worktree: /tmp/wt — exited 23.'
        },
        _meta: { runtimeId: 'runtime-1' }
      })
    )
    const priorExitCode = process.exitCode

    try {
      await main(
        ['worktree', 'rm', '--worktree', 'id:wt-1', '--force', '--run-hooks', '--json'],
        '/tmp/repo'
      )

      expect(process.exitCode).toBe(1)
      expect(callMock).toHaveBeenNthCalledWith(
        2,
        'worktree.rm',
        expect.objectContaining({
          runHooks: true,
          allowFailedArchiveHook: false
        })
      )
      expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]))).toMatchObject({
        id: 'req_archive',
        ok: false,
        error: { code: 'worktree_archive_hook_failed' },
        _meta: { runtimeId: 'runtime-1' }
      })
    } finally {
      process.exitCode = priorExitCode
    }
  })

  it('rejects the archive-hook waiver without --run-hooks instead of ignoring it', async () => {
    queueFixtures(callMock, okFixture('req_show', { worktree: { hostId: 'local' } }))
    const priorExitCode = process.exitCode

    try {
      await main(
        ['worktree', 'rm', '--worktree', 'id:wt-1', '--allow-failed-archive-hook', '--json'],
        '/tmp/repo'
      )

      expect(process.exitCode).toBe(1)
      expect(callMock).not.toHaveBeenCalledWith('worktree.rm', expect.anything())
      expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]))).toMatchObject({
        ok: false,
        error: {
          code: 'invalid_argument',
          message: expect.stringContaining('without --run-hooks no hook runs at all')
        }
      })
    } finally {
      process.exitCode = priorExitCode
    }
  })

  it('forwards the explicit archive-hook waiver on worktree rm', async () => {
    queueFixtures(
      callMock,
      okFixture('req_show', { worktree: { hostId: 'local' } }),
      okFixture('req', { removed: true })
    )

    await main(
      [
        'worktree',
        'rm',
        '--worktree',
        'id:wt-1',
        '--run-hooks',
        '--allow-failed-archive-hook',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenNthCalledWith(
      2,
      'worktree.rm',
      expect.objectContaining({ runHooks: true, allowFailedArchiveHook: true })
    )
  })

  it('still runs `terminal focus` after the handler de-duplication', async () => {
    queueFixtures(callMock, okFixture('req', { focus: { ok: true } }))

    await main(['terminal', 'focus', '--terminal', 'term_abc', '--json'], '/tmp/repo')

    expect(callMock).toHaveBeenCalledWith(
      'terminal.focus',
      expect.objectContaining({ navigation: 'host' })
    )
  })

  it('serves `agent-context --json` without contacting the runtime', async () => {
    runtimeClientConstructorMock.mockClear()
    await main(['agent-context', '--json'], '/tmp/repo')

    expect(runtimeClientConstructorMock).not.toHaveBeenCalled()
    expect(callMock).not.toHaveBeenCalled()
    const schema = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]))
    expect(schema.schemaVersion).toBe(1)
    const rm = schema.commands.find(
      (command: { command: string }) => command.command === 'worktree rm'
    )
    expect(rm.aliases).toContainEqual(['worktree', 'remove'])
  })

  it('keeps `agent-context` local when remote environment variables are set', async () => {
    vi.stubEnv('ORCA_PAIRING_CODE', 'pairing-code')
    vi.stubEnv('ORCA_ENVIRONMENT', 'stale-environment')
    try {
      await main(['agent-context', '--json'], '/tmp/repo')

      expect(process.exitCode).not.toBe(1)
      expect(callMock).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('artifact runtime routing', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    process.exitCode = 0
  })

  it('uses the desktop runtime despite remote-selection environment fallbacks', async () => {
    vi.stubEnv('ORCA_ENVIRONMENT', 'remote-environment')
    vi.stubEnv('ORCA_PAIRING_CODE', 'remote-pairing-code')
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    callMock.mockResolvedValue(
      okFixture('artifact-list', { status: 'ok', value: { artifacts: [] } })
    )
    runtimeClientConstructorMock.mockClear()

    await main(['artifacts', 'list', '--json'], '/folder-workspace')

    expect(process.exitCode).not.toBe(1)
    expect(runtimeClientConstructorMock).toHaveBeenCalledWith(null, null)
    expect(callMock).toHaveBeenCalledWith('artifacts.list', {})
  })
})

describe('unknown command surfaces a suggestion', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    callMock.mockReset()
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    errorSpy.mockRestore()
    process.exitCode = 0
  })

  it('prints did-you-mean for a near-miss command and exits non-zero', async () => {
    await main(['worktree', 'remov'], '/tmp/repo')

    expect(process.exitCode).toBe(1)
    const stderr = errorSpy.mock.calls.map((call) => String(call[0])).join('\n')
    expect(stderr).toContain('Unknown command: worktree remov')
    expect(stderr).toContain('orca worktree')
  })

  it.each([
    ['orchestration resume', 'orchestration reset'],
    ['artifacts deset', 'artifacts delete'],
    ['emulator ball', 'emulator kill'],
    ['emulator showdown', 'emulator shutdown'],
    ['orchestration worker-showw', 'orchestration worker-stop'],
    ['orchestration worker-relay', 'orchestration worker-release'],
    ['tab clues', 'tab close'],
    ['environment rollbook', 'environment rollback'],
    ['linear relation move', 'linear relation remove']
  ])('keeps %s recovery away from %s before runtime lookup', async (input, forbidden) => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    runtimeClientConstructorMock.mockClear()
    try {
      await main([...input.split(' '), '--json'], '/tmp/repo')
      expect(process.exitCode).toBe(1)
      const output = logSpy.mock.calls.flat().join('\n')
      expect(output).toContain('invalid_argument')
      expect(output).toContain('"runtimeId": null')
      expect(output).not.toContain(`orca ${forbidden}`)
      expect(output).not.toContain(`"${forbidden}"`)
      expect(runtimeClientConstructorMock).not.toHaveBeenCalled()
      expect(callMock).not.toHaveBeenCalled()
    } finally {
      logSpy.mockRestore()
    }

    await main(input.split(' '), '/tmp/repo')
    expect(errorSpy.mock.calls.flat().join('\n')).not.toContain(`orca ${forbidden}`)
    expect(runtimeClientConstructorMock).not.toHaveBeenCalled()
    expect(callMock).not.toHaveBeenCalled()
  })

  it('reports a mistyped pre-command flag without swallowing the command', async () => {
    await main(['--jso', 'worktree', 'list'], '/tmp/repo')

    expect(process.exitCode).toBe(1)
    const stderr = errorSpy.mock.calls.map((call) => String(call[0])).join('\n')
    expect(stderr).toContain('Unknown flag --jso for command: worktree list')
    expect(stderr).toContain('--json')
  })

  it('names the offending --worktree value and the valid forms on selector_not_found', async () => {
    const { RuntimeRpcFailureError } = await import('./runtime/types.js')
    callMock.mockRejectedValue(
      new RuntimeRpcFailureError({
        id: 'req_selector',
        ok: false,
        error: { code: 'selector_not_found', message: 'selector_not_found' },
        _meta: { runtimeId: 'runtime_local' }
      })
    )

    await main(
      [
        'orchestration',
        'worker-start',
        '--task',
        't1',
        '--worktree',
        'repo-1',
        '--agent',
        'codex',
        '--from',
        'term-caller'
      ],
      '/tmp/repo'
    )

    expect(process.exitCode).toBe(1)
    const stderr = errorSpy.mock.calls.map((call) => String(call[0])).join('\n')
    expect(callMock).toHaveBeenCalledExactlyOnceWith(
      'orchestration.workerStart',
      expect.objectContaining({ worktree: 'repo-1', from: 'term-caller' })
    )
    expect(stderr).toContain('No Orca workspace matched the worktree selector "repo-1"')
    expect(stderr).toContain('id:repo-1::<absolute-path>')
    expect(stderr).toContain('Valid selector forms:')
  })

  it('reports a pre-command flag that belongs to another command', async () => {
    await main(['--workspace', 'worktree', 'list'], '/tmp/repo')

    expect(process.exitCode).toBe(1)
    const stderr = errorSpy.mock.calls.map((call) => String(call[0])).join('\n')
    expect(stderr).toContain('Unknown flag --workspace for command: worktree list')
  })

  it('reports a pre-command typo when a global flag splits the command path', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['--jso', 'worktree', '--json', 'list'], '/tmp/repo')

    expect(process.exitCode).toBe(1)
    expect(logSpy.mock.calls.flat().join('\n')).toContain(
      'Unknown flag --jso for command: worktree list'
    )
    expect(callMock).not.toHaveBeenCalled()
    logSpy.mockRestore()
  })

  it.each(['environment', 'pairing-code'])(
    'rejects --%s without a selector before runtime construction',
    async (flag) => {
      runtimeClientConstructorMock.mockClear()

      await main([`--${flag}`, 'worktree', 'list'], '/tmp/repo')

      expect(process.exitCode).toBe(1)
      const stderr = errorSpy.mock.calls.map((call) => String(call[0])).join('\n')
      expect(stderr).toContain(`Flag --${flag} requires a value.`)
      expect(runtimeClientConstructorMock).not.toHaveBeenCalled()
      expect(callMock).not.toHaveBeenCalled()
    }
  )
})

describe('unknown help command surfaces a suggestion', () => {
  it.each([
    ['help prefix', ['help', 'worktree', 'remov']],
    ['help flag', ['worktree', 'remov', '--help']]
  ])('prints did-you-mean for the %s form', async (_label, argv) => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(argv, '/tmp/repo')

    expect(process.exitCode).toBe(1)
    expect(logSpy.mock.calls.flat().join('\n')).toContain('Did you mean: orca worktree')
    logSpy.mockRestore()
    process.exitCode = 0
  })
})

describe('nested command group help', () => {
  it.each([
    ['browser', ['browser', '--help'], ['identity get', 'identity set']],
    ['browser identity', ['browser', 'identity', '--help'], ['get', 'set']],
    ['browser', ['browser'], ['identity get', 'identity set']],
    ['skills', ['skills'], ['installed', 'share']],
    ['browser identity', ['browser', 'identity'], ['get', 'set']]
  ])(
    'prints successful help for %s without constructing a runtime client',
    async (path, argv, commands) => {
      const previousExitCode = process.exitCode
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      runtimeClientConstructorMock.mockClear()
      process.exitCode = 0

      try {
        await main(argv, '/tmp/repo')

        expect(process.exitCode).toBe(0)
        const output = logSpy.mock.calls.flat().join('\n')
        expect(output).toContain(`orca ${path}`)
        for (const command of commands) {
          expect(output).toContain(command)
        }
        expect(output).not.toContain('Unknown command')
        expect(runtimeClientConstructorMock).not.toHaveBeenCalled()
        expect(callMock).not.toHaveBeenCalled()
      } finally {
        process.exitCode = previousExitCode
        logSpy.mockRestore()
      }
    }
  )

  it('reports a flagged bare group as a missing subcommand, not a typo', async () => {
    const previousExitCode = process.exitCode
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    runtimeClientConstructorMock.mockClear()
    process.exitCode = 0

    try {
      await main(['skills', '--worktree', 'active'], '/tmp/repo')

      expect(process.exitCode).toBe(1)
      const stderr = errorSpy.mock.calls.flat().join('\n')
      expect(stderr).toContain('Missing subcommand for: orca skills')
      expect(stderr).toContain('orca skills --help')
      expect(stderr).not.toContain('Did you mean')
      expect(runtimeClientConstructorMock).not.toHaveBeenCalled()
    } finally {
      process.exitCode = previousExitCode
      errorSpy.mockRestore()
    }
  })

  it('keeps an executable leaf ahead of its child groups', async () => {
    const previousExitCode = process.exitCode
    process.exitCode = 0
    serveOrcaAppMock.mockClear().mockResolvedValue(0)

    try {
      await main(['serve'], '/tmp/repo')

      expect(process.exitCode).toBe(0)
      expect(serveOrcaAppMock).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ json: false })
      )
    } finally {
      process.exitCode = previousExitCode
      serveOrcaAppMock.mockReset()
    }
  })
})

describe('orca help', () => {
  it('progressively discloses Linear commands', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['--help'], '/tmp/repo')

    const rootHelp = String(logSpy.mock.calls[0][0])
    expect(rootHelp).toContain('linear')
    expect(rootHelp).not.toContain('linear issue')

    logSpy.mockClear()
    await main(['linear', '--help'], '/tmp/repo')

    const groupHelp = String(logSpy.mock.calls[0][0])
    expect(groupHelp).toContain('orca linear')
    expect(groupHelp).toContain('issue')
    expect(groupHelp).not.toContain('--comments')

    logSpy.mockClear()
    await main(['linear', 'issue', '--help'], '/tmp/repo')

    const issueHelp = String(logSpy.mock.calls[0][0])
    expect(issueHelp).toContain('orca linear issue')
    expect(issueHelp).toContain('--comments')
    expect(callMock).not.toHaveBeenCalled()
    logSpy.mockRestore()
  })
})
