import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  configureWakeDevBuildFlavor,
  isWakeDevRuntime,
  WAKE_DEV_CLI_COMMAND,
  WAKE_DEV_PROFILE_DIRECTORY
} from './wake-dev-build-flavor'

const savedEnv = {
  runtime: process.env.ORCA_WAKE_DEV_RUNTIME,
  command: process.env.ORCA_PACKAGED_COMMAND_NAME,
  socketRoot: process.env.ORCA_CONTROLLED_CODEX_SOCKET_ROOT
}

afterEach(() => {
  configureWakeDevBuildFlavor({} as never, false)
  restoreEnv('ORCA_WAKE_DEV_RUNTIME', savedEnv.runtime)
  restoreEnv('ORCA_PACKAGED_COMMAND_NAME', savedEnv.command)
  restoreEnv('ORCA_CONTROLLED_CODEX_SOCKET_ROOT', savedEnv.socketRoot)
})

describe('wake-dev build flavor', () => {
  it('leaves the official app paths and environment untouched by default', () => {
    const app = { getPath: vi.fn(), setPath: vi.fn() }
    process.env.ORCA_WAKE_DEV_RUNTIME = '1'
    const before = { ...process.env }

    configureWakeDevBuildFlavor(app as never, false)

    expect(app.getPath).not.toHaveBeenCalled()
    expect(app.setPath).not.toHaveBeenCalled()
    expect(process.env).toMatchObject(before)
    expect(isWakeDevRuntime()).toBe(false)
  })

  it('isolates packaged state, cache, logs, crashes, runtime, CLI, and sockets', () => {
    const appData = mkdtempSync(join(tmpdir(), 'orca-wake-dev-flavor-'))
    const app = {
      getPath: vi.fn(() => appData),
      setPath: vi.fn()
    }

    try {
      configureWakeDevBuildFlavor(app as never, true)

      const root = join(appData, WAKE_DEV_PROFILE_DIRECTORY)
      expect(app.setPath.mock.calls).toEqual([
        ['userData', root],
        ['sessionData', join(root, 'cache')],
        ['logs', join(root, 'logs')],
        ['crashDumps', join(root, 'crash-dumps')],
        ['temp', join(root, 'runtime')]
      ])
      expect(process.env.ORCA_PACKAGED_COMMAND_NAME).toBe(WAKE_DEV_CLI_COMMAND)
      expect(process.env.ORCA_CONTROLLED_CODEX_SOCKET_ROOT).toMatch(/^\/tmp\/ocw-wake-/)
      expect(isWakeDevRuntime()).toBe(true)
    } finally {
      rmSync(appData, { recursive: true, force: true })
    }
  })
})

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
}
