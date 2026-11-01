import { afterEach, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { createStructuredAgentEnvironmentResolvers } from '../runtime/structured-agent-shell-environment'
import { resolveStructuredAgentCommand } from '../native-chat/structured-agent-command-resolution'
import { structuredAgentConfiguredArgs } from '../native-chat/structured-agent-configured-args'
import { resolveProviderChildEnv } from '../provider-process/provider-process-launch'
import { resolveHiddenProbeCwd } from '../rate-limits/hidden-probe-cwd'
import { CODEX_SHORT_LIVED_PROBE_APP_SERVER_ARGS as tail } from '../codex-cli/codex-read-only-app-server-args'
import { agentSessionRecordFixture } from '../native-chat/agent-session-record-test-fixture'
import * as appServer from './codex-app-server-session'
import { renameCodexProviderSession } from './codex-provider-session-rename'

vi.mock('node:fs/promises', { spy: true })

let root = ''
afterEach(async () => {
  vi.restoreAllMocks()
  if (root) {
    await fs.rm(root, { recursive: true, force: true })
  }
})

it('resolves idle metadata independently of chat admission, preserving configured context and errors', async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'orca-codex-rename-'))
  const program = process.execPath
  const entrypoint = join(root, 'codex entry.mjs')
  await fs.writeFile(entrypoint, '')
  const prefix = ['--no-warnings', entrypoint]
  const settings = {
    agentCmdOverrides: { codex: `"${program}" --no-warnings "${entrypoint}"` },
    agentDefaultArgs: { codex: '-c model_provider=first --no-daemon' }
  }
  let overlay: Record<string, string> = { PATH: 'bin', CODEX_HOME: '/current', CUSTOM: 'first' }
  const environment = createStructuredAgentEnvironmentResolvers({
    resolveEnvironment: async () => ({}),
    resolveAgentLaunchEnv: () => overlay
  })
  const refresh = vi.spyOn(environment, 'refreshAfterMissingProgram')
  const workspace = vi.fn(async () => root)
  const invocation = {
    resolveWorkspacePath: workspace,
    resolveCommand: (options?: { pathEnv?: string | null; homePath?: string }) =>
      resolveStructuredAgentCommand('codex', settings, options, { resolve: () => 'codex' }),
    resolveLaunchArgs: () => structuredAgentConfiguredArgs('codex', settings),
    resolveEnvironment: () => environment.resolveAgentEnvironment('codex'),
    refreshEnvironmentAfterMiss: environment.refreshAfterMissingProgram
  }
  const request = vi.fn().mockResolvedValue({})
  const run = vi
    .spyOn(appServer, 'runCodexAppServerSession')
    .mockImplementation(async (_invocation, body) => body({ request, notify: vi.fn() }))
  const record = agentSessionRecordFixture({
    sessionId: 'chat-1',
    provider: 'codex',
    accountHome: { variable: 'CODEX_HOME', path: '/saved/account' },
    location: { workspaceId: 'global-floating-terminal' }
  })
  const rename = () =>
    renameCodexProviderSession({
      session: undefined,
      invocation,
      record,
      providerSessionId: 'thread-1',
      name: 'Release notes'
    })
  for (const candidate of [root, join(root, 'gone'), program, join(program, 'child')]) {
    record.launchDirectory = relative(process.cwd(), candidate)
    await rename()
    const invocation = run.mock.lastCall![0]
    expect(invocation).toMatchObject({
      command: program,
      cliPath: program,
      cwd: candidate === root ? root : resolveHiddenProbeCwd(),
      timeoutMs: 15_000
    })
    expect(invocation.args).toEqual([
      ...prefix,
      '-c',
      'model_provider=first',
      '--no-daemon',
      ...tail
    ])
    const stale = { ORCA_CHAT_SCRATCH_DIR: 'old', ORCA_CHAT_VISUALS_DIR: 'old' }
    const child = resolveProviderChildEnv(invocation, stale)
    expect(child).toMatchObject({ CODEX_HOME: '/saved/account', CUSTOM: 'first', PATH: 'bin' })
    expect(child.ORCA_CHAT_SCRATCH_DIR).toBeUndefined()
    expect(child.ORCA_CHAT_VISUALS_DIR).toBeUndefined()
  }
  expect(workspace).not.toHaveBeenCalled()
  record.launchDirectory = undefined
  settings.agentCmdOverrides.codex = `"${process.execPath}"`
  settings.agentDefaultArgs.codex = '-c model_provider=second'
  overlay = { PATH: 'bin', CODEX_HOME: '/other' }
  await rename()
  expect(run.mock.lastCall![0].command).toBe(process.execPath)
  expect(run.mock.lastCall![0].env?.CODEX_HOME).toBe('/saved/account')
  expect(run.mock.lastCall![0].args).toEqual(['-c', 'model_provider=second', ...tail])
  expect(run.mock.lastCall![0].env).not.toHaveProperty('CUSTOM')
  await fs.mkdir(join(root, 'bin'))
  await fs.writeFile(join(root, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex'), '', {
    mode: 0o755
  })
  settings.agentCmdOverrides.codex = ''
  await rename()
  expect(run.mock.lastCall![0]).toMatchObject({ command: 'codex', cwd: root })
  expect(refresh).not.toHaveBeenCalled()
  for (const code of ['EACCES', 'EIO']) {
    const error = Object.assign(new Error(code), { code })
    vi.spyOn(fs, 'stat').mockRejectedValueOnce(error)
    await expect(rename()).rejects.toBe(error)
  }
  const error = new Error('workspace routing unresolved')
  workspace.mockRejectedValueOnce(error)
  await expect(rename()).rejects.toBe(error)
  settings.agentCmdOverrides.codex = join(root, 'missing-command')
  await expect(rename()).rejects.toThrow('Command setting is not a runnable program')
  expect(run).toHaveBeenCalledTimes(6)
  expect(request).toHaveBeenCalledTimes(6)
  settings.agentCmdOverrides.codex = `"${program}"`
  request.mockRejectedValueOnce(new Error('thread not found'))
  await expect(rename()).rejects.toThrow('thread not found')
  expect(run).toHaveBeenCalledTimes(7)
  expect(request).toHaveBeenCalledTimes(7)
  expect(request).toHaveBeenLastCalledWith(
    'thread/name/set',
    { threadId: 'thread-1', name: 'Release notes' },
    { timeoutMs: 15_000 }
  )
})
