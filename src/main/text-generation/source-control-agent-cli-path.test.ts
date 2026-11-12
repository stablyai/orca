import { discoverTerminalModels } from '../runtime/terminal/catalog/runtime-terminal-model-discovery'
import { partialRuntimeStore } from '../runtime/orca-runtime-tests/runtime-store-partial-fixture'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { quotePosixShell } from '../../shared/shell/launch/shell-argument-quoting'
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
    writeFileSync(
      codex,
      "#!/usr/bin/env node\nconsole.log(process.argv.includes('mcp') ? '[]' : 'Fix login flow')\n"
    )
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

describe.runIf(process.platform !== 'win32')('terminal discovery launch context', () => {
  it('runs a cwd-sensitive CLI at the workspace root when cwd is omitted, with the terminal account environment', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-agy-discovery-'))
    homes.push(root)
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    const cwd = realpathSync(workspace)
    const agy = join(root, 'agy')
    writeFileSync(
      agy,
      '#!/bin/sh\nif [ "$PWD" = "$EXPECTED_CWD" ] && [ "$HOME" = "$USERPROFILE" ]; then printf "gemini-3.8-flash-low\tFlash (Low)\\n"; else printf "wrong-account\tWrong account\\n"; fi\n'
    )
    chmodSync(agy, 0o755)
    const result = await discoverTerminalModels(
      {
        store: partialRuntimeStore({
          getSettings: () => ({
            agentCmdOverrides: { antigravity: agy },
            agentDefaultEnv: {
              antigravity: {
                HOME: join(root, 'account-B'),
                USERPROFILE: join(root, 'account-B'),
                EXPECTED_CWD: cwd
              }
            }
          })
        }),
        resolveTarget: async () => ({
          managedWorktree: null,
          scope: {
            id: 'folder:test',
            path: cwd,
            connectionId: null,
            repo: null,
            folderWorkspace: null
          }
        }),
        environment: {
          resolveBaseEnvironment: async () => ({
            HOME: join(root, 'account-A'),
            PATH: '/usr/bin:/bin'
          })
        },
        uncached: true
      },
      'antigravity'
    )
    expect(result).toMatchObject({
      success: true,
      catalogOrigin: 'probe',
      models: [{ id: 'gemini-3.8-flash-low' }]
    })
  })
})
