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
    // Why: first-match resolution would silently shadow duplicate aliases.
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
    // Why: restore console.log so a downstream describe's vi.spyOn starts from a
    // clean spy — otherwise this block's --json output leaks into its calls[0].
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

  it('fails closed when worktree removal cannot resolve a host', async () => {
    queueFixtures(callMock, okFixture('req_show', { worktree: { id: 'wt-1' } }))
    const priorExitCode = process.exitCode

    try {
      await main(['worktree', 'rm', '--worktree', 'id:wt-1', '--json'], '/tmp/repo')

      expect(process.exitCode).toBe(1)
      expect(callMock).toHaveBeenCalledTimes(1)
      expect(callMock).toHaveBeenCalledWith('worktree.show', { worktree: 'id:wt-1' })
    } finally {
      process.exitCode = priorExitCode
    }
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

    // Why: pure local read — proves the SSH/offline property (no RPC).
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
    callMock.mockResolvedValue(okFixture('artifact-list', { status: 'ok', value: [] }))
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

  it('reports a mistyped pre-command flag without swallowing the command', async () => {
    await main(['--jso', 'worktree', 'list'], '/tmp/repo')

    expect(process.exitCode).toBe(1)
    const stderr = errorSpy.mock.calls.map((call) => String(call[0])).join('\n')
    expect(stderr).toContain('Unknown flag --jso for command: worktree list')
    expect(stderr).toContain('--json')
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

describe('orca root help', () => {
  it('advertises machine-readable agent discovery', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main([], '/tmp/repo')

    expect(logSpy.mock.calls.flat().join('\n')).toContain('agent-context')
    logSpy.mockRestore()
  })

  it('advertises host-local account management', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main([], '/tmp/repo')

    expect(logSpy.mock.calls.flat().join('\n')).toContain(
      'account add               Add a managed Claude or Codex account on this Orca host'
    )
    expect(logSpy.mock.calls.flat().join('\n')).toContain(
      'account list              List managed Claude and Codex accounts on this Orca host'
    )
    logSpy.mockRestore()
  })

  it('advertises computer-use capabilities discovery', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['--help'], '/tmp/repo')

    expect(logSpy.mock.calls[0][0]).toContain(
      'computer capabilities     Show computer-use provider capabilities'
    )
    expect(logSpy.mock.calls[0][0]).toContain(
      'computer permissions      Show or open computer-use permission setup'
    )
    expect(logSpy.mock.calls[0][0]).toContain(
      'computer press-key        Press a single key such as Return or Escape'
    )
    expect(logSpy.mock.calls[0][0]).toContain(
      'project setup-existing-folder Make a project available on a host by importing an existing folder'
    )
    expect(logSpy.mock.calls[0][0]).toContain(
      'project setup-create      Create independent project host setup metadata'
    )
    expect(logSpy.mock.calls[0][0]).toContain(
      'project setup-update      Update project host setup metadata'
    )
    expect(logSpy.mock.calls[0][0]).toContain(
      'project setup-delete      Remove a project host setup'
    )
    expect(logSpy.mock.calls[0][0]).toContain('Agent Sessions And Worktrees:')
    expect(logSpy.mock.calls[0][0]).toContain(
      '`worktree create --agent` creates a new checkout with an agent.'
    )
    expect(logSpy.mock.calls[0][0]).toContain(
      'orca terminal create --worktree active --command "codex"'
    )
    expect(logSpy.mock.calls[0][0]).toContain(
      'orchestration worker-start Start a supervised worker locally or on a connected Orca server'
    )
    expect(logSpy.mock.calls[0][0]).toContain(
      'orchestration ask         Ask the coordinator a blocking question'
    )
    expect(logSpy.mock.calls[0][0]).toContain(
      'orchestration worker-abandon Fence an uncertain worker without claiming it stopped'
    )
    expect(logSpy.mock.calls[0][0]).toContain(
      "orchestration worker-release Release a settled worker's terminal after archiving its output"
    )
    expect(logSpy.mock.calls[0][0]).toContain(
      'orchestration worker-retain Keep a worker terminal live for debugging'
    )
    expect(logSpy.mock.calls[0][0]).toContain(
      'orchestration worker-list Report worker terminal resource accounting'
    )
    expect(callMock).not.toHaveBeenCalled()
  })

  it('progressively discloses Linear commands', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['--help'], '/tmp/repo')

    const rootHelp = String(logSpy.mock.calls[0][0])
    expect(rootHelp).toContain('Linear:')
    expect(rootHelp).toContain('linear                    Read Linear ticket context for agents')
    expect(rootHelp).not.toContain('linear issue')
    expect(rootHelp).not.toContain('linear search')

    logSpy.mockClear()
    await main(['linear', '--help'], '/tmp/repo')

    const groupHelp = String(logSpy.mock.calls[0][0])
    expect(groupHelp).toContain('orca linear')
    expect(groupHelp).toContain('issue')
    expect(groupHelp).toContain('search')
    expect(groupHelp).not.toContain('--comments')
    expect(groupHelp).not.toContain('--attachments')

    logSpy.mockClear()
    await main(['linear', 'issue', '--help'], '/tmp/repo')

    const issueHelp = String(logSpy.mock.calls[0][0])
    expect(issueHelp).toContain('orca linear issue [<id>]')
    expect(issueHelp).toContain('--comments             Include threaded Linear comments')
    expect(issueHelp).toContain('--attachments          Include attachment metadata and URLs')
    expect(issueHelp).toContain('--activity             Include issue field-change history')
    expect(issueHelp).toContain('--workspace <id>      Connected Linear workspace id')
    expect(issueHelp).toContain('--id <id>             Linear issue key, id, or URL')

    logSpy.mockClear()
    await main(['linear', 'search', '--help'], '/tmp/repo')

    const searchHelp = String(logSpy.mock.calls[0][0])
    expect(searchHelp).toContain('orca linear search <query>')
    expect(searchHelp).toContain('--workspace <id|all>  Connected Linear workspace id, or all')
    expect(searchHelp).toContain('--query <text>        Text to search across Linear issues')

    logSpy.mockClear()
    await main(['linear', 'list-issues', '--help'], '/tmp/repo')

    const listIssuesHelp = String(logSpy.mock.calls[0][0])
    expect(listIssuesHelp).toContain(
      '--cursor <cursor>      Opaque cursor returned by a previous list-issues page'
    )
    expect(listIssuesHelp).toContain('--workspace <id|all>  Connected Linear workspace id, or all')
    expect(listIssuesHelp).not.toContain('Line cursor from a previous read')
    expect(callMock).not.toHaveBeenCalled()
  })

  it('documents the machine-readable terminal topology opt-in', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    logSpy.mockClear()

    await main(['terminal', 'list', '--help'], '/tmp/repo')

    const help = String(logSpy.mock.calls[0][0])
    expect(help).toContain('[--include-visual-layouts] [--json]')
    expect(help).toContain('--include-visual-layouts Include tab and pane topology in JSON output')
    expect(help).toContain('JSON omits visualLayouts by default')
    expect(callMock).not.toHaveBeenCalled()
  })

  it('describes worker-read cursors as opaque', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    logSpy.mockClear()

    await main(['orchestration', 'worker-read', '--help'], '/tmp/repo')

    const help = String(logSpy.mock.calls[0][0])
    expect(help).toContain(
      '--cursor <cursor>      Opaque cursor returned by a previous worker-read page'
    )
    expect(help).not.toContain('Line cursor from a previous read')
    expect(callMock).not.toHaveBeenCalled()
  })

  it('advertises Linear issue linking on worktree create and set help', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    logSpy.mockClear()

    await main(['worktree', 'create', '--help'], '/tmp/repo')

    expect(String(logSpy.mock.calls[0][0])).toContain('--linear-issue <identifier-or-url>')

    logSpy.mockClear()
    await main(['worktree', 'set', '--help'], '/tmp/repo')

    const setHelp = String(logSpy.mock.calls[0][0])
    expect(setHelp).toContain('--linear-issue <identifier-or-url|null>')
    expect(setHelp).toContain('--linear-issue <id|url|null> Linked Linear issue identifier or URL')
    expect(callMock).not.toHaveBeenCalled()
  })

  it('advertises explicit orchestration task display labels', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    logSpy.mockClear()

    await main(['orchestration', 'task-create', '--help'], '/tmp/repo')

    const help = String(logSpy.mock.calls[0][0])
    expect(help).toContain('[--task-title <text>] [--display-name <text>]')
    expect(help).toContain('--task-title <text>  Concise title for the orchestration task')
    expect(help).toContain('--display-name <text> UI label shown for dispatched worker rows')
    expect(callMock).not.toHaveBeenCalled()
  })

  it('hides removed parent-workspace help and scopes create parent selectors', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    logSpy.mockClear()

    await main(['--help'], '/tmp/repo')

    const rootHelp = String(logSpy.mock.calls[0][0])
    expect(rootHelp).not.toContain('--parent-workspace')
    expect(rootHelp).toContain('[--parent-worktree <selector>] [--no-parent]')

    logSpy.mockClear()
    await main(['worktree', 'create', '--help'], '/tmp/repo')

    const createHelp = String(logSpy.mock.calls[0][0])
    expect(createHelp).not.toContain('--parent-workspace')
    expect(createHelp).not.toContain('checkout/workspace')
    expect(createHelp).not.toContain('caller workspace')
    expect(createHelp).not.toContain('current workspace')
    expect(createHelp).not.toContain('active Orca workspace')
    expect(createHelp).not.toContain('folderWorkspaceId')
    expect(createHelp).toContain('folder:<id>')
    expect(createHelp).toContain('folder:<folderId>')
    expect(createHelp).toContain('worktree:<worktreeId>')
    expect(createHelp).toContain(
      '--no-parent only affects Orca lineage; omit --base-branch to use the repo default base'
    )

    logSpy.mockClear()
    await main(['worktree', 'set', '--help'], '/tmp/repo')

    const setHelp = String(logSpy.mock.calls[0][0])
    expect(setHelp).not.toContain('--parent-workspace')
    expect(setHelp).not.toContain('folder:<id>')
    expect(setHelp).not.toContain('worktree:<id>')
    expect(callMock).not.toHaveBeenCalled()
  })

  it('distinguishes new worktrees from fresh agent terminals in command help', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    logSpy.mockClear()

    await main(['worktree', 'create', '--help'], '/tmp/repo')

    expect(String(logSpy.mock.calls[0][0])).toContain('This creates a new checkout.')
    expect(String(logSpy.mock.calls[0][0])).toContain(
      'orca terminal create --worktree active --command "codex"'
    )

    logSpy.mockClear()
    await main(['terminal', 'create', '--help'], '/tmp/repo')

    const terminalHelp = String(logSpy.mock.calls[0][0])
    expect(terminalHelp).toContain('Use this, not worktree create')
    expect(terminalHelp).toContain(
      'orca terminal create --worktree active --command "codex" --json'
    )
    expect(callMock).not.toHaveBeenCalled()
  })
})
