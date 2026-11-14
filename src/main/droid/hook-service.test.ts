import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeOs from 'node:os'
import { removeTreeSync } from '../../shared/windows-transient-lock-removal'

const hoisted = vi.hoisted(() => ({ home: '' }))
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeOs>()
  return { ...actual, homedir: () => hoisted.home }
})

import { DroidHookService } from './hook-service'

type HookConfig = {
  hooks?: Record<string, { matcher?: string; hooks?: { command?: string }[] }[]>
}

function settingsPath(): string {
  return join(hoisted.home, '.factory', 'settings.json')
}

function isHookConfig(value: unknown): value is HookConfig {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readSettings(): HookConfig {
  const parsed: unknown = JSON.parse(readFileSync(settingsPath(), 'utf8'))
  if (!isHookConfig(parsed)) {
    throw new Error('Factory settings.json is not an object')
  }
  return parsed
}

describe('DroidHookService', () => {
  beforeEach(() => {
    hoisted.home = mkdtempSync(join(tmpdir(), 'orca-droid-home-'))
  })

  afterEach(() => {
    removeTreeSync(hoisted.home)
  })

  it('removes a managed PermissionRequest command and keeps a user command', () => {
    mkdirSync(dirname(settingsPath()), { recursive: true })
    writeFileSync(
      settingsPath(),
      `${JSON.stringify(
        {
          hooks: {
            PermissionRequest: [
              {
                matcher: '*',
                hooks: [
                  {
                    type: 'command',
                    command: '/old/path/.orca/agent-hooks/droid-hook.sh'
                  }
                ]
              },
              {
                matcher: 'Edit',
                hooks: [{ type: 'command', command: '/usr/local/bin/my-approval.sh' }]
              }
            ]
          }
        },
        null,
        2
      )}\n`
    )

    const status = new DroidHookService().install()

    expect(status.state).toBe('installed')
    expect(readSettings().hooks?.PermissionRequest).toEqual([
      {
        matcher: 'Edit',
        hooks: [{ type: 'command', command: '/usr/local/bin/my-approval.sh' }]
      }
    ])
  })
})
