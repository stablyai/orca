import { resolveCodexStructuredInvocation } from '../codex/codex-structured-launch-resolution'
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  resolveStructuredAgentCommand,
  resolveAgainAfterRefreshOnMissingProgram
} from './structured-agent-command-resolution'
import { resolveCliCommand } from '../../shared/node-cli-command-resolution'

const NOT_RUNNABLE = expect.objectContaining({
  name: 'AgentSessionPreSpawnError',
  reason: 'agentCommandNotRunnable'
})

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function executable() {
  const directory = mkdtempSync(join(tmpdir(), 'orca-command-'))
  scratch.push(directory)
  const command = join(directory, 'agent custom')
  writeFileSync(command, '#!/bin/sh\nexit 0\n')
  chmodSync(command, 0o755)
  return { directory, command }
}

describe('structured agent executable resolution', () => {
  it('reads the Command setting of any agent, and its stock binary by the name it is given', () => {
    const { command } = executable()
    expect(
      resolveStructuredAgentCommand('opencode', { agentCmdOverrides: { opencode: `"${command}"` } })
    ).toEqual({ command: command, prefixArgs: [] })
    expect(
      resolveStructuredAgentCommand(
        'opencode',
        { agentCmdOverrides: { claude: `"${command}"` } },
        { pathEnv: '/nowhere' },
        { command: 'opencode', resolve: (name) => `/stock/${name}` }
      )
    ).toEqual({ command: '/stock/opencode', prefixArgs: [] })
  })

  it('resolves a basename through the configured PATH and a home-relative path through the host home', () => {
    const { directory, command } = executable()
    const basenameCommand = join(directory, 'agent-custom')
    writeFileSync(basenameCommand, '#!/bin/sh\nexit 0\n')
    chmodSync(basenameCommand, 0o755)
    expect(
      resolveStructuredAgentCommand('codex', {
        agentCmdOverrides: { codex: 'agent-custom' },
        agentDefaultEnv: { codex: { PATH: directory } }
      })
    ).toEqual({ command: basenameCommand, prefixArgs: [] })
    expect(
      resolveStructuredAgentCommand(
        'claude',
        {
          agentCmdOverrides: { claude: '"~/agent custom"' }
        },
        { homePath: directory }
      )
    ).toEqual({ command: command, prefixArgs: [] })
  })

  it('resolves folder-relative PATH to each effective Codex executable before pooling', async () => {
    const folders = [executable(), executable()]
    for (const { directory, command } of folders) {
      const invocation = await resolveCodexStructuredInvocation({
        resolveEnvironment: async () => ({ PATH: '.' }),
        resolveWorkingDirectory: () => directory,
        resolveCommand: (options) => ({
          command: resolveCliCommand('agent custom', options),
          prefixArgs: []
        })
      })
      expect(invocation.command).toBe(command)
    }
  })

  it('rereads a changed override instead of storing another copy of the command', () => {
    const first = executable()
    const second = executable()
    const settings = { agentCmdOverrides: { claude: `"${first.command}"` } }
    expect(resolveStructuredAgentCommand('claude', settings)).toEqual({
      command: first.command,
      prefixArgs: []
    })
    settings.agentCmdOverrides.claude = `"${second.command}"`
    expect(resolveStructuredAgentCommand('claude', settings)).toEqual({
      command: second.command,
      prefixArgs: []
    })
  })

  it.each(['', '   ', undefined])('uses the stock executable when the Command is %j', (command) => {
    const settings = command === undefined ? {} : { agentCmdOverrides: { claude: command } }
    expect(resolveStructuredAgentCommand('claude', settings)).toEqual({
      command: resolveCliCommand('claude'),
      prefixArgs: []
    })
  })

  it('refuses missing files, directories, relative paths and command lines instead of the stock executable', () => {
    const { directory } = executable()
    const folder = join(directory, 'folder')
    mkdirSync(folder)
    for (const command of [
      join(directory, 'missing'),
      folder,
      './claude',
      'missing-launcher-fixture claude',
      'wrapper --flag',
      'FOO=1 claude',
      '$HOME/bin/claude'
    ]) {
      const settings = { agentCmdOverrides: { claude: command } }
      expect(() => resolveStructuredAgentCommand('claude', settings)).toThrow(NOT_RUNNABLE)
    }
  })

  it.skipIf(process.platform === 'win32')('requires executable permission on Unix', () => {
    const { command } = executable()
    chmodSync(command, 0o644)
    expect(() =>
      resolveStructuredAgentCommand('claude', { agentCmdOverrides: { claude: `"${command}"` } })
    ).toThrow(NOT_RUNNABLE)
  })

  it('keeps the saved value out of the refusal, since a command line can carry a secret', () => {
    expect(() =>
      resolveStructuredAgentCommand('codex', {
        agentCmdOverrides: { codex: 'TOKEN=sk-secret codex' }
      })
    ).toThrow(expect.not.objectContaining({ message: expect.stringContaining('sk-secret') }))
  })

  describe('on Windows', () => {
    function fileIn(directory: string, name: string): string {
      const file = join(directory, name)
      writeFileSync(file, '')
      return file
    }

    it('refuses an extensionless path, which Windows cannot spawn', () => {
      const { directory } = executable()
      const command = fileIn(directory, 'claude')
      fileIn(directory, 'claude.cmd')
      expect(() =>
        resolveStructuredAgentCommand(
          'claude',
          { agentCmdOverrides: { claude: command } },
          { platform: 'win32' }
        )
      ).toThrow(NOT_RUNNABLE)
    })

    it('refuses a name whose only match on PATH is extensionless', () => {
      const { directory } = executable()
      fileIn(directory, 'my-claude')
      expect(() =>
        resolveStructuredAgentCommand(
          'claude',
          { agentCmdOverrides: { claude: 'my-claude' } },
          { platform: 'win32', pathEnv: directory, homePath: directory }
        )
      ).toThrow(NOT_RUNNABLE)
    })

    it.each(['claude.exe', 'claude.com', 'claude.cmd', 'claude.bat'])(
      'runs an explicit %s path',
      (name) => {
        const { directory } = executable()
        const command = fileIn(directory, name)
        expect(
          resolveStructuredAgentCommand(
            'claude',
            { agentCmdOverrides: { claude: `"${command}"` } },
            { platform: 'win32' }
          )
        ).toEqual({ command: command, prefixArgs: [] })
      }
    )

    it('uses the execution host grammar for native paths after a PATH launcher', () => {
      const { directory } = executable()
      const command = fileIn(directory, 'op.exe')
      expect(
        resolveStructuredAgentCommand(
          'codex',
          {
            agentCmdOverrides: {
              codex: String.raw`op.exe run --env-file="C:\Users\dev\work env.env" -- node C:\Tools\launcher.mjs codex`
            }
          },
          { platform: 'win32', pathEnv: directory, homePath: directory }
        )
      ).toEqual({
        command,
        prefixArgs: [
          'run',
          String.raw`--env-file=C:\Users\dev\work env.env`,
          '--',
          'node',
          String.raw`C:\Tools\launcher.mjs`,
          'codex'
        ]
      })
    })

    it('finds the .cmd shim for a bare name, as the stock lookup does', () => {
      const { directory } = executable()
      fileIn(directory, 'my-claude')
      const shim = fileIn(directory, 'my-claude.cmd')
      expect(
        resolveStructuredAgentCommand(
          'claude',
          { agentCmdOverrides: { claude: 'my-claude' } },
          { platform: 'win32', pathEnv: directory, homePath: directory }
        )
      ).toEqual({ command: shim, prefixArgs: [] })
    })
  })
})

it('does not refresh or look up again after an expired async missing-program check', async () => {
  const cwd = Promise.withResolvers<string>()
  const entered = Promise.withResolvers<void>()
  let current = true
  const resolve = vi.fn(async () => ({
    command: 'absent-fixture-program',
    env: { PATH: 'relative-bin' }
  }))
  const refresh = vi.fn(async () => {})
  const result = resolveAgainAfterRefreshOnMissingProgram(
    resolve,
    refresh,
    {
      env: (row) => row.env,
      cwd: () => {
        entered.resolve()
        return cwd.promise
      }
    },
    { current: () => current }
  ).catch((error: unknown) => error)
  await entered.promise
  current = false
  cwd.resolve('/fixture')
  expect(await result).toBeInstanceOf(Error)
  expect(refresh).not.toHaveBeenCalled()
  expect(resolve).toHaveBeenCalledOnce()
})

it('expands home-relative prefix words without changing other tildes', () => {
  const { command, directory } = executable()
  expect(
    resolveStructuredAgentCommand(
      'codex',
      {
        agentCmdOverrides: { codex: `"${command}" --config ~/work.json name~file` }
      },
      { homePath: directory }
    )
  ).toEqual({
    command,
    prefixArgs: ['--config', join(directory, 'work.json'), 'name~file']
  })
})
