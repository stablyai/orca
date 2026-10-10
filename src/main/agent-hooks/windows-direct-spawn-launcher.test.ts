import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type * as Os from 'node:os'
import { join } from 'node:path'
import type * as InstallerUtils from './installer-utils'

const { getPathMock, homedirMock } = vi.hoisted(() => ({
  getPathMock: vi.fn<(name: string) => string>(),
  homedirMock: vi.fn<() => string>()
}))

vi.mock('electron', () => ({ app: { getPath: getPathMock } }))

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof Os>()
  return { ...actual, homedir: homedirMock }
})

// Why: stubbing only the path source keeps the real wrappers in play (so a wrapper swap still
// shows up) and pins a Windows path, letting this assert win32 behavior on ubuntu CI.
const WINDOWS_HOOK_DIR = 'C:\\Users\\alice\\.orca\\agent-hooks'

vi.mock('./installer-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof InstallerUtils>()
  return {
    ...actual,
    getSharedManagedScriptPath: (scriptFileName: string) =>
      `${WINDOWS_HOOK_DIR}\\${scriptFileName}`,
    writeManagedScript: vi.fn()
  }
})

import { AntigravityHookService } from '../antigravity/hook-service'
import { cursorHookService } from '../cursor/hook-service'
import { getCodexManagedHookInstallMaterial } from '../codex/hook-service'
import { getDevinManagedCommand, getDevinManagedScriptPath } from '../devin/hook-settings'

const BARE_WINDOWS_CMD_LAUNCHER = /^C:\\Users\\alice\\\.orca\\agent-hooks\\[A-Za-z0-9._-]+\.cmd$/
const ENCODED_POWERSHELL_LAUNCHER =
  /powershell\.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand \S+$/

function withPlatform<T>(platform: NodeJS.Platform, run: () => T): T {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  try {
    return run()
  } finally {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  }
}

// Why: these agents hand the command to CreateProcess as argv[0], not to cmd.exe, so anything
// but a single token naming a real .cmd is unspawnable and exits every hook 1 (#8430).
function expectDirectlySpawnable(command: string, label: string): void {
  expect(command, `${label}: launcher must be the bare managed .cmd path`).toMatch(
    BARE_WINDOWS_CMD_LAUNCHER
  )
  expect(command.split(' '), `${label}: launcher must be a single argv[0] token`).toHaveLength(1)
  expect(command, `${label}: launcher must not be a shell launcher`).not.toMatch(/powershell/i)
}

function readCursorCommand(homeDir: string): string {
  const config = JSON.parse(readFileSync(join(homeDir, '.cursor', 'hooks.json'), 'utf8')) as {
    hooks: Record<string, { command?: string }[]>
  }
  return config.hooks.stop?.[0]?.command ?? ''
}

function readAntigravityCommands(homeDir: string): string[] {
  const config = JSON.parse(
    readFileSync(join(homeDir, '.gemini', 'config', 'hooks.json'), 'utf8')
  ) as {
    'orca-status': Record<string, { command?: string; hooks?: { command?: string }[] }[]>
  }
  return Object.values(config['orca-status']).flatMap((definitions) =>
    definitions.map((definition) => definition.command ?? definition.hooks?.[0]?.command ?? '')
  )
}

describe('Windows direct-spawn hook launcher contract', () => {
  let homeDir: string

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'orca-direct-spawn-home-'))
    homedirMock.mockReturnValue(homeDir)
    getPathMock.mockReturnValue(homeDir)
  })

  afterEach(() => {
    vi.clearAllMocks()
    rmSync(homeDir, { recursive: true, force: true })
  })

  it('keeps the Codex managed command directly spawnable', () => {
    const { command } = withPlatform('win32', () => getCodexManagedHookInstallMaterial())
    expectDirectlySpawnable(command, 'codex')
  })

  it('keeps the Devin managed command directly spawnable', () => {
    const command = withPlatform('win32', () => getDevinManagedCommand(getDevinManagedScriptPath()))
    expectDirectlySpawnable(command, 'devin')
  })

  it('keeps every Antigravity managed command directly spawnable', () => {
    withPlatform('win32', () => new AntigravityHookService().install())
    const commands = readAntigravityCommands(homeDir)
    expect(commands.length).toBeGreaterThan(0)
    for (const command of commands) {
      expectDirectlySpawnable(command, 'antigravity')
    }
  })

  // Why: pins the split — Cursor's runner goes through a shell, so it must keep the encoded
  // launcher. Without this, "make every agent spawnable" would look like a valid refactor.
  it('keeps a shell-launched agent on the encoded PowerShell launcher', () => {
    withPlatform('win32', () => cursorHookService.install())
    const command = readCursorCommand(homeDir)
    expect(command).toMatch(ENCODED_POWERSHELL_LAUNCHER)
    expect(command).not.toMatch(BARE_WINDOWS_CMD_LAUNCHER)
  })
})
