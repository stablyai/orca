// Why (#2426): Antigravity reads silence on PreToolUse as a deny, so a Windows hook entry it
// cannot start is not lost status — it denies every tool call. Antigravity starts a hook
// `command` as a program (#8737), so the entry has to name a file on every profile, and that
// file has to be the one that answers the gate.
import { describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type * as osModule from 'node:os'
import { join } from 'node:path'

const { homedirMock } = vi.hoisted(() => ({ homedirMock: vi.fn<() => string>() }))

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof osModule>()
  return { ...actual, homedir: homedirMock }
})

import { AntigravityHookService, getManagedCommand } from './hook-service'
import { ANTIGRAVITY_EVENTS, ANTIGRAVITY_PRE_TOOL_USE_DECISION } from './hook-events'
import { WINDOWS_CMD_SAFE_PATH } from '../agent-hooks/installer-utils'

const WRAPPER_TAIL = '\\.orca\\agent-hooks\\antigravity-pre-tool-use.cmd'

/**
 * Installs into a Windows-shaped home whose path carries a space, then hands back the managed
 * script path. `state === 'installed'` is the load-bearing part: getStatus() only reports it when
 * every event's hooks.json entry equals getManagedCommand(), so the assertions below read the
 * string Antigravity is actually handed.
 */
function withSpacedWindowsInstall(run: (home: string, scriptPath: string) => void): void {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  // Why: a space is the ordinary shape of a Windows profile (`C:\Users\First Last`) and the one
  // character that decides which launcher the installer picks.
  const home = mkdtempSync(join(tmpdir(), 'orca antigravity spaced '))
  homedirMock.mockReturnValue(home)
  try {
    expect(new AntigravityHookService().install().state).toBe('installed')
    run(home, join(home, '.orca', 'agent-hooks', 'antigravity-hook.cmd'))
  } finally {
    vi.restoreAllMocks()
    rmSync(home, { recursive: true, force: true })
  }
}

describe('Antigravity Windows hook command spawnability', () => {
  // Why a control: every assertion below is worthless if a spaced profile were not in the class
  // the installer treats specially. Pin both sides of that gate before relying on it.
  it('treats a spaced Windows profile path as the diverted class, and an ASCII one as safe', () => {
    expect(WINDOWS_CMD_SAFE_PATH.test(`C:\\Users\\alice${WRAPPER_TAIL}`)).toBe(true)
    expect(WINDOWS_CMD_SAFE_PATH.test(`C:\\Users\\First Last${WRAPPER_TAIL}`)).toBe(false)
  })

  it('registers a single startable script path for every event on a spaced profile', () => {
    withSpacedWindowsInstall((home, scriptPath) => {
      for (const event of ANTIGRAVITY_EVENTS) {
        const command = getManagedCommand(scriptPath, event)
        expect(command, event.eventName).toBe(
          join(home, '.orca', 'agent-hooks', event.windowsWrapperFileName)
        )
        // Why: a program name is startable only if it names a file. A multi-token launcher string
        // never does, and a hook that never starts writes no stdout at all.
        expect(existsSync(command), `${event.eventName} command is not a file`).toBe(true)
        expect(command, event.eventName).not.toMatch(/powershell|-EncodedCommand/i)
      }
    })
  })

  it('keeps answering the PreToolUse gate from that path when the core script is gone', () => {
    withSpacedWindowsInstall((home, scriptPath) => {
      // Why: hooks.json lives in ~/.gemini and outlives ~/.orca, so a swept core must not take the
      // gate answer with it — this is what fallbackStdout buys the POSIX command.
      rmSync(join(home, '.orca', 'agent-hooks', 'antigravity-hook.cmd'))
      const preToolUse = ANTIGRAVITY_EVENTS.find((event) => event.eventName === 'PreToolUse')!

      const command = getManagedCommand(scriptPath, preToolUse)
      expect(existsSync(command)).toBe(true)
      expect(readFileSync(command, 'utf8')).toContain(`echo ${ANTIGRAVITY_PRE_TOOL_USE_DECISION}`)
    })
  })
})
