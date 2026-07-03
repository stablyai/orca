import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const { getPathMock, homedirMock } = vi.hoisted(() => ({
  getPathMock: vi.fn<(name: string) => string>(),
  homedirMock: vi.fn<() => string>()
}))

vi.mock('electron', () => ({
  app: {
    getPath: getPathMock
  }
}))

vi.mock('os', async () => {
  const actual = (await vi.importActual('os')) as Record<string, unknown>
  return {
    ...actual,
    homedir: homedirMock
  }
})

import { DroidHookService } from './hook-service'

const WINDOWS_POWERSHELL_LAUNCHER =
  /^[A-Za-z]:\/[^"]*\/System32\/WindowsPowerShell\/v1\.0\/powershell\.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand \S+$/

describe('DroidHookService', () => {
  let homeDir: string
  let userDataDir: string

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'orca-droid-home-'))
    userDataDir = mkdtempSync(join(tmpdir(), 'orca-droid-user-data-'))
    homedirMock.mockReturnValue(homeDir)
    getPathMock.mockImplementation((name: string) => {
      if (name === 'userData') {
        return userDataDir
      }
      throw new Error(`unexpected getPath(${name})`)
    })
  })

  afterEach(() => {
    vi.clearAllMocks()
    rmSync(homeDir, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  })

  it('installs the managed command for Droid status events', () => {
    const status = new DroidHookService().install()

    expect(status.state).toBe('installed')
    expect(status.managedHooksPresent).toBe(true)

    const config = JSON.parse(readFileSync(join(homeDir, '.factory', 'settings.json'), 'utf8')) as {
      hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]>
    }
    expect(Object.keys(config.hooks).sort()).toEqual(
      [
        'Notification',
        'PermissionRequest',
        'PostToolUse',
        'PreToolUse',
        'SessionStart',
        'Stop',
        'SubagentStop',
        'UserPromptSubmit'
      ].sort()
    )
    expect(config.hooks.PreToolUse[0].matcher).toBe('*')
    expect(config.hooks.PermissionRequest[0].matcher).toBe('*')
    expect(config.hooks.UserPromptSubmit[0].matcher).toBeUndefined()
    expect(config.hooks.PreToolUse[0].hooks[0].command).toMatch(
      process.platform === 'win32' ? WINDOWS_POWERSHELL_LAUNCHER : /droid-hook/
    )
    if (process.platform !== 'win32') {
      expect(config.hooks.PreToolUse[0].hooks[0].command).toContain(join(homeDir, '.orca'))
    }
    expect(config.hooks.PreToolUse[0].hooks[0].command).not.toContain(userDataDir)
  })

  // Why: #6078 — a Windows user profile path with a space used to be written
  // verbatim as the hook command, so the agent split it at the space. The
  // managed command must use an encoded launcher so the path never appears raw
  // on the cmd.exe command line.
  it.skipIf(process.platform !== 'win32')(
    'wraps the managed hook command to survive spaces in the profile path (#6078)',
    () => {
      const spaceHome = join(tmpdir(), 'orca droid home with spaces')
      mkdirSync(spaceHome, { recursive: true })
      homedirMock.mockReturnValue(spaceHome)
      try {
        expect(new DroidHookService().install().state).toBe('installed')

        const config = JSON.parse(
          readFileSync(join(spaceHome, '.factory', 'settings.json'), 'utf8')
        ) as { hooks: Record<string, { hooks: { command: string }[] }[]> }

        for (const eventName of ['SessionStart', 'UserPromptSubmit', 'Stop']) {
          const command = config.hooks[eventName]?.[0]?.hooks?.[0]?.command
          expect(command).toMatch(WINDOWS_POWERSHELL_LAUNCHER)
        }
      } finally {
        rmSync(spaceHome, { recursive: true, force: true })
      }
    }
  )

  // Why: #6069 — the managed droid hook must emit Factory's suppressOutput
  // directive on EVERY exit path so droid hides the hook block, while staying
  // fail-open (always exit 0). A bare "contains the JSON" check would pass even
  // if a regression dropped the emit on the listener-down / empty-payload paths,
  // so these assert the script's path structure, not mere substring presence.
  describe('managed script suppressOutput structure (#6069)', () => {
    it('emits suppressOutput before every exit 0 in the POSIX body', () => {
      // Pin a POSIX platform so this runs host-independently — on a Windows dev
      // box install() would write droid-hook.cmd and the .sh read would ENOENT.
      const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
      try {
        new DroidHookService().install()

        const body = readFileSync(join(homeDir, '.orca', 'agent-hooks', 'droid-hook.sh'), 'utf8')
        const lines = body.split('\n')

        // Pin the printf one-liner so a future echo swap can't introduce platform escapes.
        expect(body).toContain(
          "orca_suppress_output() {\n  printf '%s\\n' '{\"suppressOutput\":true}'\n}"
        )

        // Every `exit 0` must be immediately preceded by the suppress emission.
        const exitIndexes = lines
          .map((line, index) => ({ line: line.trim(), index }))
          .filter((entry) => entry.line === 'exit 0')
          .map((entry) => entry.index)
        expect(exitIndexes.length).toBeGreaterThan(0)
        for (const index of exitIndexes) {
          expect(lines[index - 1].trim()).toBe('orca_suppress_output')
        }

        // Fail-open POST and final exit are still present.
        expect(body).toContain(
          'curl -sS -X POST "http://127.0.0.1:${ORCA_AGENT_HOOK_PORT}/hook/droid"'
        )
        expect(body).toContain('>/dev/null 2>&1 || true')
      } finally {
        if (originalPlatform) {
          Object.defineProperty(process, 'platform', originalPlatform)
        }
      }
    })

    it('routes Windows guards through a single :suppress label after the curl block', () => {
      // getManagedScript() branches on process.platform at call time, so drive
      // the Windows body directly to keep its fragile caret/label form tested
      // from non-Windows CI.
      const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
      try {
        new DroidHookService().install()

        const body = readFileSync(join(homeDir, '.orca', 'agent-hooks', 'droid-hook.cmd'), 'utf8')
        const lines = body.split('\r\n')

        // All three env-var guards short-circuit to the shared label.
        expect(body).toContain('if "%ORCA_AGENT_HOOK_PORT%"=="" goto suppress')
        expect(body).toContain('if "%ORCA_AGENT_HOOK_TOKEN%"=="" goto suppress')
        expect(body).toContain('if "%ORCA_PANE_KEY%"=="" goto suppress')

        // Exactly one :suppress label, sitting after the curl block.
        const labelIndexes = lines
          .map((line, index) => ({ line, index }))
          .filter((entry) => entry.line === ':suppress')
          .map((entry) => entry.index)
        expect(labelIndexes).toHaveLength(1)
        const curlIndex = lines.findIndex((line) => line.includes('curl.exe'))
        expect(curlIndex).toBeGreaterThanOrEqual(0)
        expect(labelIndexes[0]).toBeGreaterThan(curlIndex)

        // Fail-open guarantee: no exit before the label re-introduces a non-zero path.
        const firstExitIndex = lines.findIndex((line) => line.trim() === 'exit /b 0')
        expect(firstExitIndex).toBeGreaterThan(labelIndexes[0])

        // The emitted echo must not carry a trailing space (cmd echoes it verbatim).
        expect(lines).toContain('echo {"suppressOutput":true}')
        expect(body).not.toContain('echo {"suppressOutput":true} ')
      } finally {
        if (originalPlatform) {
          Object.defineProperty(process, 'platform', originalPlatform)
        }
      }
    })
  })

  it('reports partial when Factory has hooks disabled globally', () => {
    const configPath = join(homeDir, '.factory', 'settings.json')
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(configPath, `${JSON.stringify({ hooksDisabled: true }, null, 2)}\n`)

    const status = new DroidHookService().install()

    expect(status.state).toBe('partial')
    expect(status.managedHooksPresent).toBe(true)
    expect(status.detail).toBe('Droid hooks are disabled in Factory settings')
  })
})
