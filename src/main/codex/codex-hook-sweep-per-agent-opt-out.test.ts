import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type * as Os from 'node:os'
import { join } from 'node:path'
import { wrapPosixHookCommand } from '../agent-hooks/installer-utils'
import { setupCodexHookHomes } from './hook-service-test-harness'

const { getPathMock, homedirMock } = vi.hoisted(() => ({
  getPathMock: vi.fn<(name: string) => string>(),
  homedirMock: vi.fn<() => string>()
}))

vi.mock('electron', () => ({
  app: {
    getPath: getPathMock
  }
}))

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof Os>()
  return {
    ...actual,
    homedir: homedirMock
  }
})

import { CodexHookService } from './hook-service'

const homes = setupCodexHookHomes(homedirMock, getPathMock)

function orcaEntryCommand(): string {
  const scriptPath = join(
    homes.userDataDir,
    'agent-hooks',
    process.platform === 'win32' ? 'codex-hook.cmd' : 'codex-hook.sh'
  )
  return process.platform === 'win32' ? scriptPath : wrapPosixHookCommand(scriptPath)
}

function seedRealHomeHooks(): string {
  const systemCodexHome = join(homes.tmpHome, '.codex')
  const systemHooksPath = join(systemCodexHome, 'hooks.json')
  mkdirSync(systemCodexHome, { recursive: true })
  writeFileSync(
    systemHooksPath,
    `${JSON.stringify({
      hooks: {
        Stop: [
          { hooks: [{ type: 'command', command: 'user-hook' }] },
          { hooks: [{ type: 'command', command: orcaEntryCommand() }] }
        ]
      }
    })}\n`,
    'utf-8'
  )
  return systemHooksPath
}

function realHomeStopHooks(systemHooksPath: string): unknown {
  return JSON.parse(readFileSync(systemHooksPath, 'utf-8')).hooks.Stop
}

// Why: Codex turned off per agent reaches remove(), the explicit opt-out that alone
// strips the shared real-home entry.
describe('Codex turned off per agent', () => {
  it('removes the Orca entry from the real ~/.codex and keeps user hooks', async () => {
    const systemHooksPath = seedRealHomeHooks()

    await new CodexHookService().remove()

    expect(realHomeStopHooks(systemHooksPath)).toEqual([
      { hooks: [{ type: 'command', command: 'user-hook' }] }
    ])
  })
})
