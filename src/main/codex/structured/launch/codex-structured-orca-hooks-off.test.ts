import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { buildCodexHookCommand } from '../../hooks/definitions/codex-hook-command-form'
import { getManagedScriptPath } from '../../hooks/definitions/codex-hook-definition'
import { codexOrcaHooksOffArgs } from './codex-structured-orca-hooks-off'

let home = ''
afterEach(() => rmSync(home, { recursive: true, force: true }))

// Expected keys spell a POSIX home.
it.skipIf(process.platform === 'win32')(
  "disables Orca's Codex hook entries for the launch and leaves the user's hooks enabled",
  () => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'orca-codex-hooks-off-')))
    const orca = { type: 'command', command: buildCodexHookCommand(getManagedScriptPath()) }
    const olderOrca = {
      type: 'command',
      command: '/bin/sh "$HOME/.orca/agent-hooks/codex-hook.sh"'
    }
    const user = { type: 'command', command: 'echo user-hook' }
    writeFileSync(
      join(home, 'hooks.json'),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            null,
            { hooks: [user, null, { type: 'command', command: ['sh'] }, olderOrca] }
          ],
          PostToolUse: [{ hooks: [user, orca] }]
        }
      })
    )

    expect(codexOrcaHooksOffArgs(home)).toEqual([
      '-c',
      `hooks.state={"${home}/hooks.json:pre_tool_use:1:3"={enabled=false},"${home}/hooks.json:post_tool_use:0:1"={enabled=false}}`
    ])
  }
)
