import { execFileSync, spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  lockAgeSecondsCommand,
  tryCreateInstallLockCommand,
  tryStealInstallLockCommand
} from './ssh-relay-install-lock-commands'
import {
  commandInRemoteDirectory,
  commandWithNodePath,
  listRelayBaseDirsCommand,
  makeRemoteDirectoryCommand,
  probeRelayInstalledCommand,
  readRemoteHomeCommand,
  relayLivenessProbeCommand
} from './ssh-remote-commands'
import { getRemoteHostPlatform } from './ssh-remote-platform'

const posix = getRemoteHostPlatform('linux-x64')
const windows = getRemoteHostPlatform('win32-x64')
const powerShellExecutable = (
  process.platform === 'win32' ? ['pwsh.exe', 'powershell.exe'] : ['pwsh']
).find((candidate) => {
  const result = spawnSync(candidate, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], {
    stdio: 'ignore'
  })
  return result.status === 0
})

function decodePowerShellCommand(command: string): string {
  const match = command.match(/-EncodedCommand\s+([A-Za-z0-9+/=]+)/)
  return match ? Buffer.from(match[1], 'base64').toString('utf16le') : ''
}

function runShellCommand(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', command], {
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout)
        return
      }
      reject(new Error(`shell exited ${code}: ${stderr}`))
    })
  })
}

describe('ssh remote command builders', () => {
  it('keeps POSIX deploy commands POSIX-native', () => {
    expect(readRemoteHomeCommand(posix)).toBe('echo $HOME')
    expect(makeRemoteDirectoryCommand(posix, '/home/me/.orca-remote')).toContain('mkdir -p')
    expect(probeRelayInstalledCommand(posix, '/home/me/relay')).toContain('test -d')
  })

  it('uses encoded PowerShell for Windows deploy commands', () => {
    expect(readRemoteHomeCommand(windows)).toContain('powershell.exe')
    expect(makeRemoteDirectoryCommand(windows, 'C:/Users/me/.orca-remote')).toContain(
      '-EncodedCommand'
    )
    expect(probeRelayInstalledCommand(windows, 'C:/Users/me/relay')).toContain('-EncodedCommand')
  })

  it('uses -Path for Windows New-Item commands', () => {
    const mkdirScript = decodePowerShellCommand(
      makeRemoteDirectoryCommand(windows, 'C:/Users/me/.orca-remote')
    )
    const lockScript = decodePowerShellCommand(
      tryCreateInstallLockCommand(windows, 'C:/Users/me/.orca-remote/relay/.install-lock')
    )

    expect(mkdirScript).toContain('New-Item -ItemType Directory -Force -Path')
    expect(lockScript).toContain('New-Item -ItemType Directory -Path')
    expect(mkdirScript).not.toContain('New-Item -ItemType Directory -Force -LiteralPath')
    expect(lockScript).not.toContain('New-Item -ItemType Directory -LiteralPath')
  })

  it('uses named pipe try-connect liveness for Windows GC', () => {
    const command = relayLivenessProbeCommand(windows, 'C:/Users/me/.orca-remote/relay-0.1.0', {
      nodePath: 'C:/Program Files/nodejs/node.exe',
      pipePaths: ['\\\\.\\pipe\\orca-relay-1234567890abcdef1234']
    })
    const script = decodePowerShellCommand(command)

    expect(command).toContain('powershell.exe')
    expect(script).toContain('net.connect(pipe)')
    expect(script).toContain('.windows-active-pipe-')
    expect(script).toContain('markerCount===0&&pipes.length===0')
    expect(script).toContain('C:\\Program Files\\nodejs')
    expect(script).not.toContain('Win32_Process')
    expect(listRelayBaseDirsCommand(windows, 'C:/Users/me/.orca-remote')).toContain(
      '-EncodedCommand'
    )
  })

  it('escapes double quotes before passing JavaScript to native Windows commands', () => {
    const script = decodePowerShellCommand(
      relayLivenessProbeCommand(windows, 'C:/Users/me/.orca-remote/relay-0.1.0', {
        nodePath: 'C:/Program Files/nodejs/node.exe',
        pipePaths: ['\\\\.\\pipe\\orca-relay-1234567890abcdef1234']
      })
    )

    expect(script).toContain('fs=require(\\"fs\\")')
    expect(script).toContain('net=require(\\"net\\")')
  })

  it('prepends the Windows node bin directory to PATH with native separators', () => {
    const script = decodePowerShellCommand(
      commandWithNodePath(
        windows,
        'C:/Program Files/nodejs/node.exe',
        'C:/Users/me/.orca-remote/relay-0.1.0',
        "'READY'"
      )
    )

    expect(script).toContain("$env:PATH = 'C:\\Program Files\\nodejs' + ';' + $env:PATH")
  })

  it('keeps the Windows install-lock try/catch parseable', () => {
    const script = decodePowerShellCommand(
      tryCreateInstallLockCommand(windows, 'C:/Users/me/.orca-remote/relay/.install-lock')
    )

    expect(script).toContain('$ErrorActionPreference = "Stop"; try {')
    expect(script).toContain("} catch { 'BUSY' }")
    expect(script).not.toContain('}; catch')
  })

  it('computes install-lock age on the remote host clock', () => {
    const posixCommand = lockAgeSecondsCommand(posix, '/home/me/.orca-remote/relay/.install-lock')
    const windowsScript = decodePowerShellCommand(
      lockAgeSecondsCommand(windows, 'C:/Users/me/.orca-remote/relay/.install-lock')
    )

    expect(posixCommand).toContain('date +%s')
    expect(posixCommand).toContain('echo "$age"')
    expect(windowsScript).toContain('[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()')
    expect(windowsScript).toContain('Write-Output ($now - $mtime)')
  })

  it('serializes stale recovery with unbounded numbered sibling claims', () => {
    const posixCommand = tryStealInstallLockCommand(
      posix,
      '/home/me/.orca-remote/relay/.install-lock',
      20 * 60
    )
    const windowsScript = decodePowerShellCommand(
      tryStealInstallLockCommand(windows, 'C:/Users/me/.orca-remote/relay/.install-lock', 20 * 60)
    )

    expect(posixCommand).toContain('.install-lock')
    expect(posixCommand).toContain('.install-lock.steal')
    expect(posixCommand).toContain('steal_generation')
    expect(posixCommand).toContain('mtime=${lock_key%%:*}')
    expect(posixCommand).toContain('-gt 1200')
    expect(posixCommand).toContain('current_mtime')
    expect(posixCommand).toContain('steal_generation + 1')
    expect(posixCommand).not.toContain('.next.')
    expect(posixCommand).toContain('trap')
    expect(windowsScript).toContain('$lock.steal')
    expect(windowsScript).toContain('$stealGeneration++')
    expect(windowsScript).toContain('-gt 1200')
    expect(windowsScript).toContain('$currentIdentity -eq $lockIdentity')
    expect(windowsScript).not.toContain('.next.')
    expect(windowsScript).toContain('finally')
  })

  it.runIf(powerShellExecutable)('emits a parseable Windows stale-lock recovery command', () => {
    const script = decodePowerShellCommand(
      tryStealInstallLockCommand(
        windows,
        'C:/Users/orca-missing/.orca-remote/relay/.install-lock',
        20 * 60
      )
    )
    const result = spawnSync(
      powerShellExecutable!,
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8' }
    )

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout.trim()).toBe('BUSY')
  })

  it.runIf(process.platform !== 'win32')(
    'recovers and cleans more than eight orphaned numbered steal claims',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'orca-install-lock-'))
      try {
        const lockDir = join(root, '.install-lock')
        mkdirSync(lockDir)
        const staleDate = new Date(Date.now() - 60 * 60_000)
        utimesSync(lockDir, staleDate, staleDate)
        const lockMtimeSeconds = Math.floor(statSync(lockDir).mtimeMs / 1000)
        for (let i = 0; i < 12; i++) {
          const orphan = `${lockDir}.steal.${i}`
          mkdirSync(orphan)
          utimesSync(orphan, staleDate, staleDate)
        }

        const command = tryStealInstallLockCommand(posix, lockDir, 20 * 60)
        const output = execFileSync('/bin/sh', ['-c', command], { encoding: 'utf8' })

        expect(output.trim()).toBe('OK')
        expect(existsSync(lockDir)).toBe(true)
        expect(readdirSync(root).filter((name) => name.includes('.steal.'))).toHaveLength(0)
        expect(Math.floor(statSync(lockDir).mtimeMs / 1000)).toBeGreaterThan(lockMtimeSeconds)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  )

  it.runIf(process.platform !== 'win32')(
    'lets only one POSIX caller move and recreate a stale install lock',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'orca-install-lock-race-'))
      try {
        const lockDir = join(root, '.install-lock')
        mkdirSync(lockDir)
        const staleDate = new Date(Date.now() - 60 * 60_000)
        utimesSync(lockDir, staleDate, staleDate)
        const command = tryStealInstallLockCommand(posix, lockDir, 20 * 60)
        const outputs = await Promise.all(
          Array.from({ length: 64 }, () => runShellCommand(command))
        )
        const okCount = outputs.filter((output) => output.trim().endsWith('OK')).length

        expect(okCount).toBe(1)
        expect(existsSync(lockDir)).toBe(true)
        expect(readdirSync(root).some((name) => name.includes('.tombstone'))).toBe(false)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  )

  it('makes Windows remote directory changes fail before running scoped commands', () => {
    const scopedCommand = decodePowerShellCommand(
      commandInRemoteDirectory(windows, 'C:/Users/me/.orca-remote/relay-0.1.0', "'READY'")
    )
    const nodeScopedCommand = decodePowerShellCommand(
      commandWithNodePath(
        windows,
        'C:/Program Files/nodejs/node.exe',
        'C:/Users/me/.orca-remote/relay-0.1.0',
        "'READY'"
      )
    )

    expect(scopedCommand).toContain(
      "Set-Location -ErrorAction Stop -LiteralPath 'C:/Users/me/.orca-remote/relay-0.1.0'"
    )
    expect(nodeScopedCommand).toContain(
      "Set-Location -ErrorAction Stop -LiteralPath 'C:/Users/me/.orca-remote/relay-0.1.0'"
    )
  })
})
