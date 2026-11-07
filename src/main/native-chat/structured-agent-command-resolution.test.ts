import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveStructuredAgentCommand } from './structured-agent-command-resolution'

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
  })
})
