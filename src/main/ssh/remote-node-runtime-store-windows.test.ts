import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as DeployHelpers from './ssh-relay-deploy-helpers'

vi.mock('./ssh-relay-deploy-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof DeployHelpers>()),
  execCommand: vi.fn()
}))

import type { SshConnection } from './ssh-connection'
import { gcRemoteNodeRuntimeStore, parseSweptRuntimeStages } from './remote-node-runtime-store-gc'
import { RUNTIME_STORE_LOCK_NAME } from './remote-node-runtime-store-lock'
import { parseRuntimeStoreInventory } from './remote-node-runtime-store-inventory'
import {
  windowsRuntimeStoreInventoryCommand,
  windowsSweepStaleRuntimeStagesCommand
} from './remote-node-runtime-store-windows'
import { execCommand } from './ssh-relay-deploy-helpers'
import { getRemoteHostPlatform } from './ssh-remote-platform'
import { decodeRemotePowerShellScript } from './ssh-remote-powershell'
import { removeTreeSync } from '../../shared/windows-transient-lock-removal'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: all connection access is replaced by execCommand's mock.
const conn = {} as SshConnection
const host = getRemoteHostPlatform('win32-x64')
const mockExec = vi.mocked(execCommand)
const sha = (c: string): string => c.repeat(64)
const root = 'C:/Users/ada/.orca-remote'
const store = `${root}/runtimes`

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

describe('Windows runtime store commands', () => {
  it('stay inside the EDR posture: one encoded powershell.exe line, no policy switch, no compilation', () => {
    for (const command of [
      windowsRuntimeStoreInventoryCommand(root),
      windowsSweepStaleRuntimeStagesCommand(store, 20, 'SWEPT')
    ]) {
      expect(command).toMatch(/^powershell\.exe -NoProfile -NonInteractive -EncodedCommand \S+$/)
      expect(decodeRemotePowerShellScript(command)).not.toMatch(
        /ExecutionPolicy|Add-Type|\.ps1|Import-Module/
      )
    }
  })

  it('finds process holds by image path under runtimes\\, never by image name', () => {
    const script = decodeRemotePowerShellScript(windowsRuntimeStoreInventoryCommand(root))
    expect(script).toContain(
      `Get-CimInstance -ClassName Win32_Process -Filter "ExecutablePath LIKE '%\\\\runtimes\\\\%'" -Property ExecutablePath -ErrorAction Stop`
    )
    expect(script).not.toMatch(/Name\s*=|node\.exe|ProcessName/)
    // A failed query must not report that the check ran.
    expect(script.indexOf("Write-Output 'PROCESS_CHECK cim'")).toBeGreaterThan(
      script.indexOf('Get-CimInstance')
    )
  })

  it('falls back to Get-Process image paths when WMI refuses a standard user', () => {
    const script = decodeRemotePowerShellScript(windowsRuntimeStoreInventoryCommand(root))
    const fallback = script.slice(script.indexOf("Write-Output 'PROCESS_CHECK cim'"))
    expect(fallback).toContain(
      "Get-Process -ErrorAction Stop | Where-Object { $_.Path -and $_.Path.IndexOf('\\runtimes\\', [StringComparison]::OrdinalIgnoreCase) -ge 0 }"
    )
    expect(fallback.indexOf("Write-Output 'PROCESS_CHECK process'")).toBeGreaterThan(
      fallback.indexOf('Get-Process')
    )
  })

  it('reads both ref shapes from every sibling of runtimes\\', () => {
    const script = decodeRemotePowerShellScript(windowsRuntimeStoreInventoryCommand(root))
    expect(script).toContain("Join-Path $d.FullName '.runtime-node'")
    expect(script).toContain("$_.Name.StartsWith('.runtime-ref-node-')")
    expect(script).toContain("$_.Name -ne 'runtimes'")
  })
})

describe('parseRuntimeStoreInventory with Windows output', () => {
  it('takes holds from backslash image paths in any case, tombstones included', () => {
    const inventory = parseRuntimeStoreInventory(
      [
        'DIR relay-0.1.0+abc',
        `REF ${sha('a')}`,
        `ENTRY node-${sha('a')}`,
        `ENTRY node-${sha('b')}`,
        `VERIFIED node-${sha('b')}`,
        'PROCESS_CHECK cim',
        `HOLD C:\\Users\\ada\\.orca-remote\\Runtimes\\node-${sha('b').toUpperCase()}\\node.exe`,
        `HOLD C:\\Users\\ada\\.orca-remote\\runtimes\\.gc-tombstone-node-${sha('c')}.1.2\\node.exe`,
        'HOLD C:\\Program Files\\nodejs\\node.exe',
        '__ORCA_RUNTIME_STORE__OK'
      ].join('\r\n')
    )
    expect(inventory?.processCheckRan).toBe(true)
    expect([...(inventory?.held ?? [])]).toEqual([sha('b'), sha('c')])
    expect([...(inventory?.referenced ?? [])]).toEqual([sha('a')])
  })
})

describe('gcRemoteNodeRuntimeStore on a Windows host', () => {
  beforeEach(() => {
    mockExec.mockReset()
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  it('runs under the store lock with unwrapped powershell.exe commands and collects an idle runtime', async () => {
    const scripts: string[] = []
    mockExec.mockImplementation(async (_conn, command, options) => {
      expect(command).toMatch(/^powershell\.exe /)
      expect(options).toMatchObject({ wrapCommand: false })
      const script = decodeRemotePowerShellScript(command)
      scripts.push(script)
      if (script.includes(RUNTIME_STORE_LOCK_NAME) && script.includes('CreateNew')) {
        return 'OK'
      }
      if (script.includes('Win32_Process')) {
        return [
          'DIR relay-0.1.0+abc',
          `REF ${sha('a')}`,
          `ENTRY node-${sha('a')}`,
          `ENTRY node-${sha('b')}`,
          `ENTRY node-${sha('c')}`,
          `VERIFIED node-${sha('a')}`,
          `VERIFIED node-${sha('b')}`,
          `VERIFIED node-${sha('c')}`,
          'PROCESS_CHECK cim',
          '__ORCA_RUNTIME_STORE__OK'
        ].join('\r\n')
      }
      if (script.includes('Move-Item')) {
        return 'MOVED'
      }
      return ''
    })

    const result = await gcRemoteNodeRuntimeStore(conn, host, 'C:/Users/ada', {
      currentPins: [sha('a')]
    })

    // `a` is pinned and referenced, `b` is the newest other verified runtime (keep two).
    expect(result).toMatchObject({ state: 'collected', removed: [`node-${sha('c')}`] })
    const lockTaken = scripts.findIndex((s) => s.includes('CreateNew'))
    const inventoried = scripts.findIndex((s) => s.includes('Win32_Process'))
    const released = scripts.findLastIndex(
      (s) => s.startsWith('Remove-Item') && s.includes(RUNTIME_STORE_LOCK_NAME)
    )
    expect(lockTaken).toBe(0)
    expect(inventoried).toBeGreaterThan(lockTaken)
    expect(released).toBe(scripts.length - 1)
  })

  it('keeps everything when the process query did not run', async () => {
    mockExec.mockImplementation(async (_conn, command) => {
      const script = decodeRemotePowerShellScript(command)
      if (script.includes('CreateNew')) {
        return 'OK'
      }
      if (script.includes('Win32_Process')) {
        return [
          `ENTRY node-${sha('c')}`,
          `VERIFIED node-${sha('c')}`,
          '__ORCA_RUNTIME_STORE__OK'
        ].join('\n')
      }
      return ''
    })
    const result = await gcRemoteNodeRuntimeStore(conn, host, 'C:/Users/ada', {
      currentPins: [sha('a')]
    })
    expect(result).toMatchObject({ state: 'collected', removed: [] })
    expect(
      mockExec.mock.calls.some(([, command]) =>
        decodeRemotePowerShellScript(command).includes('Move-Item')
      )
    ).toBe(false)
  })
})

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

  it('inventories refs, entries and verified order', () => {
    const remote = join(home, '.orca-remote')
    const relay = join(remote, 'relay-0.1.0+abc')
    mkdirSync(relay, { recursive: true })
    writeFileSync(join(relay, `.runtime-ref-node-${sha('a')}`), `${sha('a')}\n`)
    for (const [c, age] of [
      ['a', 60],
      ['b', 0]
    ] as const) {
      const entry = join(remote, 'runtimes', `node-${sha(c)}`)
      mkdirSync(entry, { recursive: true })
      writeFileSync(join(entry, '.verified'), '')
      const at = Date.now() / 1000 - age
      utimesSync(join(entry, '.verified'), at, at)
    }
    const inventory = parseRuntimeStoreInventory(run(windowsRuntimeStoreInventoryCommand(remote)))
    expect(inventory?.dirNames).toEqual(['relay-0.1.0+abc'])
    expect([...(inventory?.referenced ?? [])]).toEqual([sha('a')])
    expect(inventory?.verifiedNewestFirst).toEqual([`node-${sha('b')}`, `node-${sha('a')}`])
  })

  // Why Windows only: the hold comes from Win32_Process, which only Windows answers.
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
        // Why wait: Windows will not delete the temp store while its image is still running.
        if (child.pid !== undefined && child.exitCode === null) {
          const exited = new Promise((resolve) => child.once('exit', resolve))
          child.kill()
          await exited
        }
      }
    }
  )

  it('sweeps only stages nothing has written to within the stale rule', () => {
    const runtimes = join(home, 'runtimes')
    const old = Date.now() / 1000 - 21 * 60
    const stage = (name: string, fileAge: number): string => {
      const dir = join(runtimes, name)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'node.zip'), 'x')
      utimesSync(join(dir, 'node.zip'), fileAge, fileAge)
      utimesSync(dir, old, old)
      return dir
    }
    stage('.stage-node-x-1', old)
    stage('.stage-node-x-2', Date.now() / 1000)
    const out = run(windowsSweepStaleRuntimeStagesCommand(runtimes, 20, 'SWEPT'))
    expect(parseSweptRuntimeStages(out)).toEqual(['.stage-node-x-1'])
  })
})
