import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type * as Os from 'node:os'
import { join } from 'node:path'
import { wrapPosixHookCommand } from '../agent-hooks/installer-utils'
import type { GlobalSettings } from '../../shared/global-settings-types'
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
import {
  setSystemCodexHomeHookSweepSuppressed,
  shouldSuppressSystemCodexHomeHookSweep
} from './codex-hook-legacy-cleanup'

const homes = setupCodexHookHomes(homedirMock, getPathMock)

type HookSettings = Pick<GlobalSettings, 'agentStatusHooksEnabled' | 'disabledTuiAgents'>

const CODEX_OFF: HookSettings = { agentStatusHooksEnabled: true, disabledTuiAgents: ['codex'] }
const ALL_ON: HookSettings = { agentStatusHooksEnabled: true, disabledTuiAgents: [] }
const OTHER_OFF: HookSettings = { agentStatusHooksEnabled: true, disabledTuiAgents: ['claude'] }
const GLOBAL_OFF: HookSettings = { agentStatusHooksEnabled: false, disabledTuiAgents: [] }

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

describe('system ~/.codex sweep gate', () => {
  afterEach(() => {
    setSystemCodexHomeHookSweepSuppressed(() => false)
  })

  it.each([
    { label: 'Codex turned off', settings: CODEX_OFF, suppressed: false },
    { label: 'the global switch off', settings: GLOBAL_OFF, suppressed: false },
    { label: 'every agent on', settings: ALL_ON, suppressed: true },
    { label: 'another agent turned off', settings: OTHER_OFF, suppressed: true }
  ])('on the real-home lane with $label, suppressed=$suppressed', ({ settings, suppressed }) => {
    expect(
      shouldSuppressSystemCodexHomeHookSweep({ isHostSystemDefaultRealHome: true, settings })
    ).toBe(suppressed)
  })

  it('never suppresses off the real-home lane', () => {
    expect(
      shouldSuppressSystemCodexHomeHookSweep({
        isHostSystemDefaultRealHome: false,
        settings: ALL_ON
      })
    ).toBe(false)
  })

  it('turning Codex off removes the Orca entry from the real ~/.codex and keeps user hooks', async () => {
    const systemHooksPath = seedRealHomeHooks()
    setSystemCodexHomeHookSweepSuppressed(() =>
      shouldSuppressSystemCodexHomeHookSweep({
        isHostSystemDefaultRealHome: true,
        settings: CODEX_OFF
      })
    )

    await new CodexHookService().remove()

    expect(realHomeStopHooks(systemHooksPath)).toEqual([
      { hooks: [{ type: 'command', command: 'user-hook' }] }
    ])
  })

  it('leaves the real-home entry in place while Codex hooks are on', async () => {
    const systemHooksPath = seedRealHomeHooks()
    setSystemCodexHomeHookSweepSuppressed(() =>
      shouldSuppressSystemCodexHomeHookSweep({
        isHostSystemDefaultRealHome: true,
        settings: ALL_ON
      })
    )

    await new CodexHookService().remove()

    expect(realHomeStopHooks(systemHooksPath)).toEqual([
      { hooks: [{ type: 'command', command: 'user-hook' }] },
      { hooks: [{ type: 'command', command: orcaEntryCommand() }] }
    ])
  })
})
