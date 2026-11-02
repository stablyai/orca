import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { quotePosixShell } from '../../shared/shell-argument-quoting'
import { generateConversationNameFromContext } from './commit-message-text-generation'

const homes: string[] = []

afterEach(() => {
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true })
  }
})

function writeAgent(home: string, folder: string, output: string): void {
  const bin = join(home, folder)
  mkdirSync(bin, { recursive: true })
  const file = join(bin, 'codex')
  writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' ${quotePosixShell(output)}\n`)
  chmodSync(file, 0o755)
}

describe.runIf(process.platform !== 'win32')('chat naming CLI discovery', () => {
  it('finds an nvm Codex when a GUI process PATH omits its bin directory', async () => {
    const home = mkdtempSync(join(tmpdir(), 'orca-naming-nvm-'))
    homes.push(home)
    mkdirSync(join(home, 'empty-path'))
    const bin = join(home, '.nvm', 'versions', 'node', 'v24.1.0', 'bin')
    mkdirSync(bin, { recursive: true })
    symlinkSync(process.execPath, join(bin, 'node'))
    const codex = join(bin, 'codex')
    writeFileSync(codex, "#!/usr/bin/env node\nconsole.log('Fix login flow')\n")
    chmodSync(codex, 0o755)

    const result = await generateConversationNameFromContext(
      { firstPrompt: 'Fix the login flow' },
      { agentId: 'codex', model: 'default' },
      { kind: 'local', cwd: home, env: { HOME: home, PATH: join(home, 'empty-path') } }
    )

    expect(result).toMatchObject({ success: true, name: 'Fix login flow', agentLabel: 'Codex' })
  })

  it.each([
    ['./node_modules/.bin:EMPTY', 'node_modules/.bin'],
    [':EMPTY', '.'],
    ['EMPTY:', '.']
  ])('resolves recipe PATH %s from the workspace before global installs', async (path, folder) => {
    const home = mkdtempSync(join(tmpdir(), 'orca-naming-recipe-path-'))
    homes.push(home)
    mkdirSync(join(home, 'empty-path'))
    writeAgent(home, folder, 'Project CLI')
    writeAgent(home, '.local/bin', 'Wrong global CLI')

    const result = await generateConversationNameFromContext(
      { firstPrompt: 'Fix the login flow' },
      {
        agentId: 'custom',
        model: '',
        customAgentCommand: `PATH=${path.replace('EMPTY', join(home, 'empty-path'))} codex`
      },
      { kind: 'local', cwd: home, env: { HOME: home, PATH: join(home, 'empty-path') } }
    )

    expect(result).toMatchObject({ success: true, name: 'Project CLI' })
  })
})
