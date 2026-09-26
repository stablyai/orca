// Why (#21514 follow-up): refresh must land the impl before rewriting the launcher —
// a pre-launcher install whose impl write fails has to keep its old payload, not be
// stranded as a launcher answering {} for every event while reaching nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as osModule from 'node:os'
import type * as refreshModule from './managed-hook-script-refresh'

let isolatedUserDataDir = ''
let previousUserDataPath: string | undefined

beforeEach(() => {
  previousUserDataPath = process.env.ORCA_USER_DATA_PATH
  isolatedUserDataDir = mkdtempSync(join(tmpdir(), 'orca-hook-refresh-order-user-data-'))
  process.env.ORCA_USER_DATA_PATH = isolatedUserDataDir
})

afterEach(() => {
  if (previousUserDataPath === undefined) {
    delete process.env.ORCA_USER_DATA_PATH
  } else {
    process.env.ORCA_USER_DATA_PATH = previousUserDataPath
  }
  rmSync(isolatedUserDataDir, { recursive: true, force: true })
})

const { homedirMock, restoreMock } = vi.hoisted(() => ({
  homedirMock: vi.fn<() => string>(),
  restoreMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/orca-user-data'
  }
}))

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof osModule>()
  return {
    ...actual,
    homedir: homedirMock.mockImplementation(actual.homedir)
  }
})

vi.mock('./managed-hook-script-refresh', async (importOriginal) => {
  const actual = await importOriginal<typeof refreshModule>()
  return {
    ...actual,
    restoreManagedScript: restoreMock
  }
})

import { ClaudeHookService } from '../claude/hook-service'

async function withPlatform<T>(platform: NodeJS.Platform, run: () => T | Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  try {
    return await run()
  } finally {
    if (original) {
      Object.defineProperty(process, 'platform', original)
    }
  }
}

const PRE_LAUNCHER_PAYLOAD = [
  '@echo off',
  'setlocal',
  'echo {"legacy":true}',
  'exit /b 0',
  ''
].join('\r\n')

describe('refreshManagedScripts launcher ordering', () => {
  it('keeps the old payload when the impl restore fails on a pre-launcher install', async () => {
    const home = mkdtempSync(join(tmpdir(), 'orca-hook-refresh-order-'))
    homedirMock.mockReturnValue(home)
    restoreMock.mockRejectedValue(new Error('impl write failed'))
    try {
      const hooksDir = join(home, '.orca', 'agent-hooks')
      mkdirSync(hooksDir, { recursive: true })
      const scriptPath = join(hooksDir, 'claude-hook.cmd')
      writeFileSync(scriptPath, PRE_LAUNCHER_PAYLOAD)

      await expect(
        withPlatform('win32', () => new ClaudeHookService().refreshManagedScripts())
      ).rejects.toThrow('impl write failed')

      // Why: the failure must leave the previous contract in place — the script stays
      // the old working payload instead of becoming a launcher with no impl behind it.
      expect(readFileSync(scriptPath, 'utf8')).toBe(PRE_LAUNCHER_PAYLOAD)
    } finally {
      homedirMock.mockImplementation(() => process.env.HOME ?? tmpdir())
      rmSync(home, { recursive: true, force: true })
    }
  })
})
