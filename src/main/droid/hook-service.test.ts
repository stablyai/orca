import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type * as NodeOs from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sandbox = vi.hoisted(() => ({ home: '' }))
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeOs>()),
  homedir: () => sandbox.home
}))

import { DroidHookService } from './hook-service'

describe('DroidHookService', () => {
  beforeEach(() => {
    sandbox.home = mkdtempSync(join(tmpdir(), 'orca-droid-home-'))
  })

  afterEach(() => {
    rmSync(sandbox.home, { recursive: true, force: true })
  })

  it('drops a previously managed PermissionRequest hook but keeps the user hook on it', () => {
    const configPath = join(sandbox.home, '.factory', 'settings.json')
    const userDefinition = {
      matcher: 'Edit',
      hooks: [{ type: 'command', command: '/usr/local/bin/my-approval.sh' }]
    }
    const managedCommand = join(sandbox.home, '.orca', 'agent-hooks', 'droid-hook.sh')
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(
      configPath,
      JSON.stringify({
        hooks: {
          PermissionRequest: [
            { matcher: '*', hooks: [{ type: 'command', command: managedCommand }] },
            userDefinition
          ]
        }
      })
    )

    expect(new DroidHookService().install().state).toBe('installed')

    const installed = JSON.parse(readFileSync(configPath, 'utf8'))
    expect(installed.hooks.PermissionRequest).toEqual([userDefinition])
  })
})
