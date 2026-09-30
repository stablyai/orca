import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type * as Os from 'node:os'
import { join } from 'node:path'
import { isOrcaAgentHookCommand } from '../agent-hooks/installer-utils'
import { setupCodexHookHomes } from './hook-service-test-harness'

const { getPathMock, homedirMock } = vi.hoisted(() => ({
  getPathMock: vi.fn<(name: string) => string>(),
  homedirMock: vi.fn<() => string>()
}))

vi.mock('electron', () => ({ app: { getPath: getPathMock } }))

vi.mock('os', async (importOriginal) => ({
  ...(await importOriginal<typeof Os>()),
  homedir: homedirMock
}))

import { CodexHookService } from './hook-service'

const homes = setupCodexHookHomes(homedirMock, getPathMock)

describe('Orca hook identity in Codex hook files (#22434)', () => {
  it.each([
    "/bin/sh '/home/u/.orca/agent-hooks/claude-hook.sh'",
    'C:\\Users\\u\\.orca\\agent-hooks\\claude-hook.cmd',
    "powershell -File '.orca\\agent-hooks\\gemini-hook.ps1'"
  ])('recognises %s as Orca’s', (command) => {
    expect(isOrcaAgentHookCommand(command)).toBe(true)
  })

  it.each(['/home/u/bin/my-hook.sh', '/opt/other/agent-hooks/claude-hook.sh', 'echo .orca'])(
    'leaves %s to the user',
    (command) => {
      expect(isOrcaAgentHookCommand(command)).toBe(false)
    }
  )

  it('does not mirror a Claude hook that Codex’s importer copied into ~/.codex/hooks.json', async () => {
    const systemCodexHome = join(homes.tmpHome, '.codex')
    mkdirSync(systemCodexHome, { recursive: true })
    const importedClaudeHook = `/bin/sh '${join(homes.tmpHome, '.orca', 'agent-hooks', 'claude-hook.sh')}'`
    const systemHooks = {
      hooks: {
        SessionEnd: [{ hooks: [{ type: 'command', command: importedClaudeHook, timeout: 10 }] }],
        Stop: [
          { hooks: [{ type: 'command', command: importedClaudeHook, timeout: 10 }] },
          { hooks: [{ type: 'command', command: 'echo user-hook' }] }
        ]
      }
    }
    const systemHooksPath = join(systemCodexHome, 'hooks.json')
    writeFileSync(systemHooksPath, `${JSON.stringify(systemHooks)}\n`, 'utf-8')
    writeFileSync(join(systemCodexHome, 'config.toml'), 'model = "m"\n', 'utf-8')

    expect((await new CodexHookService().install()).state).toBe('installed')

    const runtimeHooks = readFileSync(
      join(homes.userDataDir, 'codex-runtime-home', 'home', 'hooks.json'),
      'utf-8'
    )
    expect(runtimeHooks).not.toContain('claude-hook')
    expect(runtimeHooks).not.toContain('SessionEnd')
    expect(runtimeHooks).toContain('echo user-hook')
    // The user's own file is left as it was (removing there is an owner decision).
    expect(JSON.parse(readFileSync(systemHooksPath, 'utf-8'))).toEqual(systemHooks)
  })
})
