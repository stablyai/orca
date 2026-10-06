import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveStructuredAgentCommand } from './structured-agent-command-resolution'
import { resolveCliCommand } from '../../shared/node-cli-command-resolution'

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
  it.each(['claude', 'codex'] as const)(
    'uses the configured %s executable on the execution host',
    (agent) => {
      const { command } = executable()
      const settings = { agentCmdOverrides: { [agent]: `"${command}"` } }
      expect(resolveStructuredAgentCommand(agent, settings)).toBe(command)
    }
  )

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
    ).toBe(basenameCommand)
    expect(
      resolveStructuredAgentCommand(
        'claude',
        {
          agentCmdOverrides: { claude: '"~/agent custom"' }
        },
        { homePath: directory }
      )
    ).toBe(command)
  })

  it('rereads a changed override instead of storing another copy of the command', () => {
    const first = executable()
    const second = executable()
    const settings = { agentCmdOverrides: { claude: `"${first.command}"` } }
    expect(resolveStructuredAgentCommand('claude', settings)).toBe(first.command)
    settings.agentCmdOverrides.claude = `"${second.command}"`
    expect(resolveStructuredAgentCommand('claude', settings)).toBe(second.command)
  })

  it('uses the stock executable for missing files, directories, relative paths and shell lines', () => {
    const { directory } = executable()
    const folder = join(directory, 'folder')
    mkdirSync(folder)
    for (const command of [
      join(directory, 'missing'),
      folder,
      './claude',
      'npx claude',
      'wrapper --flag'
    ]) {
      const settings = { agentCmdOverrides: { claude: command } }
      expect(resolveStructuredAgentCommand('claude', settings)).toBe(resolveCliCommand('claude'))
    }
  })

  it.skipIf(process.platform === 'win32')('requires executable permission on Unix', () => {
    const { command } = executable()
    chmodSync(command, 0o644)
    expect(
      resolveStructuredAgentCommand('claude', { agentCmdOverrides: { claude: `"${command}"` } })
    ).toBe(resolveCliCommand('claude'))
  })
})
