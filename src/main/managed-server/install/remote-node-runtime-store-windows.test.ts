import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { parseRuntimeStoreInventory } from './remote-node-runtime-store-inventory'
import { windowsRuntimeStoreInventoryCommand } from './remote-node-runtime-store-windows'
import { decodeRemotePowerShellScript } from '../../ssh/remote-exec/ssh-remote-powershell'
import { removeTreeSync } from '../../../shared/windows-transient-lock-removal'
const sha = (c: string): string => c.repeat(64)

const powerShell = [
  process.env.ORCA_POWERSHELL_EXECUTABLE,
  ...(process.platform === 'win32' ? ['powershell.exe', 'pwsh.exe'] : ['pwsh'])
].find(
  (candidate) =>
    candidate &&
    spawnSync(candidate, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], {
      stdio: 'ignore'
    }).status === 0
)

describe.runIf(powerShell)('Windows runtime store commands (real PowerShell)', () => {
  let home: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'orca-win-store-'))
  })
  afterEach(() => {
    removeTreeSync(home)
  })

  function run(command: string): string {
    const result = spawnSync(
      powerShell!,
      ['-NoProfile', '-NonInteractive', '-Command', decodeRemotePowerShellScript(command)],
      { encoding: 'utf8' }
    )
    expect(result.status, result.stderr).toBe(0)
    return result.stdout
  }

  it.runIf(process.platform === 'win32')(
    'holds a runtime whose node.exe is running, found by its image path',
    { timeout: 120_000 },
    async () => {
      const remote = join(home, '.orca-remote')
      const entry = join(remote, 'runtimes', `node-${sha('d')}`)
      mkdirSync(entry, { recursive: true })
      const exe = join(entry, 'node.exe')
      copyFileSync(process.execPath, exe)
      const child = spawn(exe, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
      try {
        await new Promise((resolve, reject) => {
          child.once('spawn', resolve)
          child.once('error', reject)
        })
        const inventory = parseRuntimeStoreInventory(
          run(windowsRuntimeStoreInventoryCommand(remote))
        )
        expect(inventory?.processCheckRan).toBe(true)
        expect([...(inventory?.held ?? [])]).toEqual([sha('d')])
      } finally {
        // Windows cannot delete a runtime while its image is running.
        if (child.pid !== undefined && child.exitCode === null) {
          const exited = new Promise((resolve) => child.once('exit', resolve))
          child.kill()
          await exited
        }
      }
    }
  )
})
