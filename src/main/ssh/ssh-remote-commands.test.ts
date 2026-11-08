import { execFileSync, spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  rmSync,
  statSync,
  utimesSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { decodeRemotePowerShellScript } from './ssh-remote-powershell'
import {
  tryCreateInstallLockCommand,
  tryStealInstallLockCommand
} from '../managed-server/install/remote-install-lock-commands'
import {
  listRemoteInstallBaseDirsCommand,
  MAX_REMOTE_INSTALL_GC_LISTING_ENTRIES,
  probeRemoteInstallCompleteCommand
} from './ssh-remote-commands'
import {
  ORCAD_INSTALL_MODEL,
  RELAY_INSTALL_MODEL
} from '../managed-server/install/remote-install-model'
import { getRemoteHostPlatform } from './ssh-remote-platform'
import {
  createRelayGcListingFixture,
  readUncappedRelayGcPaths,
  runCappedRelayGcShellCommand,
  SSH_EXEC_OUTPUT_CAP_CHARS
} from '../managed-server/install/remote-install-gc-listing.test-fixture'

const posix = getRemoteHostPlatform('linux-x64')
const nativePosix = getRemoteHostPlatform(
  process.platform === 'darwin' ? 'darwin-x64' : 'linux-x64'
)
const windows = getRemoteHostPlatform('win32-x64')
const powerShellExecutable = [
  process.env.ORCA_POWERSHELL_EXECUTABLE,
  ...(process.platform === 'win32' ? ['pwsh.exe', 'powershell.exe'] : ['pwsh'])
].find((candidate) => {
  if (!candidate) {
    return false
  }
  const result = spawnSync(candidate, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], {
    stdio: 'ignore'
  })
  return result.status === 0
})
const powerShell51Executable =
  process.platform === 'win32' &&
  spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], {
    stdio: 'ignore'
  }).status === 0
    ? 'powershell.exe'
    : undefined

const listRelayBaseDirsCommand = (host: typeof posix, baseDir: string): string =>
  listRemoteInstallBaseDirsCommand(host, baseDir, RELAY_INSTALL_MODEL)

function probeOrcadInstalledCommand(host: typeof posix, dir: string): string {
  return probeRemoteInstallCompleteCommand(host, dir, [
    ...ORCAD_INSTALL_MODEL.requiredArtifacts(host),
    ORCAD_INSTALL_MODEL.installCompleteFilename
  ])
}

function decodePowerShellCommand(command: string): string {
  return command.includes('-EncodedCommand ') ? decodeRemotePowerShellScript(command) : ''
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

function runPowerShellCommand(executable: string, script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['-NoProfile', '-NonInteractive', '-Command', script], {
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
      reject(new Error(`PowerShell exited ${code}: ${stderr}`))
    })
  })
}

describe('ssh remote command builders', () => {
  // Stage a complete install, then remove one artifact: the probe must flip.
  function stageOrcadInstall(host: typeof posix): { dir: string; artifact: string } {
    const dir = mkdtempSync(join(tmpdir(), 'orca-install-probe-'))
    const artifacts = ORCAD_INSTALL_MODEL.requiredArtifacts(host)
    for (const filename of artifacts) {
      mkdirSync(dirname(join(dir, filename)), { recursive: true })
      writeFileSync(join(dir, filename), '')
    }
    writeFileSync(join(dir, ORCAD_INSTALL_MODEL.installCompleteFilename), '')
    return { dir, artifact: artifacts.at(-1)! }
  }

  it.skipIf(process.platform === 'win32')(
    'answers a POSIX install complete only with every artifact present, in its own dir',
    async () => {
      const { dir, artifact } = stageOrcadInstall(nativePosix)
      try {
        const run = async (installDir: string): Promise<string> =>
          (await runShellCommand(probeOrcadInstalledCommand(nativePosix, installDir))).trim()
        expect(await run(dir)).toBe('OK')
        // The relative test must not resolve against the caller's working directory.
        expect(await run(join(dir, 'missing slot'))).toBe('MISSING')
        rmSync(join(dir, artifact))
        expect(await run(dir)).toBe('MISSING')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  )

  it.skipIf(!powerShellExecutable)('rejects a Windows install missing one artifact', async () => {
    const { dir, artifact } = stageOrcadInstall(windows)
    const probe = (): string => decodePowerShellCommand(probeOrcadInstalledCommand(windows, dir))
    try {
      expect((await runPowerShellCommand(powerShellExecutable!, probe())).trim()).toBe('OK')

      rmSync(join(dir, artifact))
      expect((await runPowerShellCommand(powerShellExecutable!, probe())).trim()).toBe('MISSING')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it.runIf(process.platform !== 'win32')(
    'bounds real POSIX GC output with more than the exec-cap stage population',
    async () => {
      const fixture = createRelayGcListingFixture()
      try {
        const paths = await readUncappedRelayGcPaths(fixture.findCommand)
        expect(paths.join('\n').length).toBeGreaterThan(SSH_EXEC_OUTPUT_CAP_CHARS)
        const cappedRaw = await runCappedRelayGcShellCommand(
          `${fixture.findCommand} | LC_ALL=C sort`
        )
        expect(cappedRaw.length).toBe(SSH_EXEC_OUTPUT_CAP_CHARS)
        for (const name of fixture.validNames) {
          expect(cappedRaw).not.toContain(join(fixture.root, name))
        }

        const output = await runCappedRelayGcShellCommand(
          listRelayBaseDirsCommand(posix, fixture.root)
        )
        const entries = output.trim().split('\n')

        expect([...entries].sort()).toEqual(['relay-0.1.0+aaa', 'relay-0.1.0+bbb'])
        expect(Buffer.byteLength(output)).toBeLessThan(1_024)
        expect(entries.length).toBeLessThanOrEqual(MAX_REMOTE_INSTALL_GC_LISTING_ENTRIES)

        fixture.fillValidEntryBoundary()
        const validNames = new Set(fixture.validNames)
        const unboundedEntries = (await readUncappedRelayGcPaths(fixture.findCommand))
          .map((path) => basename(path))
          .filter((name) => validNames.has(name))
        expect(unboundedEntries).toHaveLength(65)
        const boundedOutput = await runCappedRelayGcShellCommand(
          listRelayBaseDirsCommand(posix, fixture.root)
        )
        const boundedEntries = boundedOutput.trim().split('\n')
        expect(boundedEntries).toEqual(unboundedEntries.slice(0, 64))
        expect(boundedEntries).toHaveLength(64)
        expect(new Set(boundedEntries).size).toBe(64)
        expect(Buffer.byteLength(boundedOutput)).toBeLessThan(1_024)
      } finally {
        fixture.dispose()
      }
    },
    30_000
  )

  it.runIf(process.platform !== 'win32')(
    'fails closed when real POSIX GC enumeration fails',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'orca-relay-gc-failure-'))
      try {
        const command = `find() { return 23; }\n${listRelayBaseDirsCommand(posix, root)}`
        await expect(runShellCommand(command)).rejects.toThrow('shell exited 1')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  )

  it.runIf(powerShellExecutable)(
    'emits a parseable Windows stale-lock recovery command',
    () => {
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
    },
    15_000
  )

  it.runIf(powerShell51Executable)(
    'lets only one Windows PowerShell 5.1 caller acquire an install lock',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'orca-install-lock-windows-race-'))
      try {
        const lockPath = join(root, '.install-lock')
        const script = decodePowerShellCommand(tryCreateInstallLockCommand(windows, lockPath))
        const outputs = await Promise.all(
          Array.from({ length: 16 }, () => runPowerShellCommand(powerShell51Executable!, script))
        )

        expect(outputs.filter((output) => output.trim().endsWith('OK'))).toHaveLength(1)
        expect(statSync(lockPath).isDirectory()).toBe(true)
        expect(statSync(join(lockPath, '.owner')).isFile()).toBe(true)
        expect(readFileSync(join(lockPath, '.boot-id'), 'utf8')).toMatch(/^win32:\d+$/u)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
    30_000
  )

  it.runIf(powerShell51Executable)(
    'atomically replaces a fresh Windows lock only after the remote boot changes',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'orca-install-lock-windows-reboot-'))
      try {
        const lockPath = join(root, '.install-lock')
        const acquire = decodePowerShellCommand(tryCreateInstallLockCommand(windows, lockPath))
        const recover = decodePowerShellCommand(
          tryStealInstallLockCommand(windows, lockPath, 20 * 60)
        )

        await expect(runPowerShellCommand(powerShell51Executable!, acquire)).resolves.toMatch(/OK/u)
        await expect(runPowerShellCommand(powerShell51Executable!, recover)).resolves.toMatch(
          /^BUSY\s*$/u
        )

        writeFileSync(join(lockPath, '.boot-id'), 'partial')
        await expect(runPowerShellCommand(powerShell51Executable!, recover)).resolves.toMatch(
          /^BUSY\s*$/u
        )

        writeFileSync(join(lockPath, '.boot-id'), 'win32:0')
        const outputs = await Promise.all(
          Array.from({ length: 4 }, () => runPowerShellCommand(powerShell51Executable!, recover))
        )

        expect(outputs.filter((output) => output.trim() === 'REBOOT_OK')).toHaveLength(1)
        expect(readFileSync(join(lockPath, '.boot-id'), 'utf8')).toMatch(/^win32:\d+$/u)
        expect(readdirSync(root).filter((name) => name.includes('.tombstone.'))).toHaveLength(0)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
    30_000
  )

  it.runIf(powerShell51Executable)(
    'recovers a stale Windows lock past abandoned steal generations',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'orca-install-lock-windows-stale-'))
      try {
        const lockPath = join(root, '.install-lock')
        mkdirSync(lockPath)
        const staleDate = new Date(Date.now() - 60 * 60_000)
        utimesSync(lockPath, staleDate, staleDate)
        for (let i = 0; i < 12; i++) {
          const orphan = `${lockPath}.steal.${i}`
          mkdirSync(orphan)
          utimesSync(orphan, staleDate, staleDate)
        }
        const script = decodePowerShellCommand(
          tryStealInstallLockCommand(windows, lockPath, 20 * 60)
        )

        const output = await runPowerShellCommand(powerShell51Executable!, script)

        expect(output.trim()).toBe('OK')
        expect(statSync(lockPath).isDirectory()).toBe(true)
        expect(statSync(join(lockPath, '.owner')).isFile()).toBe(true)
        expect(readdirSync(root).filter((name) => name.includes('.steal.'))).toHaveLength(0)
        expect(readdirSync(root).filter((name) => name.includes('.tombstone.'))).toHaveLength(0)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
    15_000
  )

  it.runIf(powerShell51Executable)(
    'lets only one Windows PowerShell 5.1 caller replace a stale lock',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'orca-install-lock-windows-steal-race-'))
      try {
        const lockPath = join(root, '.install-lock')
        mkdirSync(lockPath)
        const staleDate = new Date(Date.now() - 60 * 60_000)
        utimesSync(lockPath, staleDate, staleDate)
        const script = decodePowerShellCommand(
          tryStealInstallLockCommand(windows, lockPath, 20 * 60)
        )

        const outputs = await Promise.all(
          Array.from({ length: 16 }, () => runPowerShellCommand(powerShell51Executable!, script))
        )

        expect(outputs.filter((output) => output.trim().endsWith('OK'))).toHaveLength(1)
        expect(statSync(lockPath).isDirectory()).toBe(true)
        expect(statSync(join(lockPath, '.owner')).isFile()).toBe(true)
        expect(readdirSync(root).filter((name) => name.includes('.tombstone.'))).toHaveLength(0)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
    30_000
  )

  it.runIf(powerShellExecutable)(
    'keeps a new Windows lock visible to the previous directory-only GC probe',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'orca-install-lock-windows-compat-'))
      try {
        const lockPath = join(root, '.install-lock')
        const acquire = decodePowerShellCommand(tryCreateInstallLockCommand(windows, lockPath))
        // The directory-only lock probe older Orca builds still run against this host.
        const legacyProbe = `if (Test-Path -LiteralPath '${lockPath}' -PathType Container) { 'LOCKED' } else { 'OPEN' }`

        await expect(runPowerShellCommand(powerShellExecutable!, acquire)).resolves.toMatch(/OK/)
        await expect(runPowerShellCommand(powerShellExecutable!, legacyProbe)).resolves.toMatch(
          /LOCKED/
        )
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
    15_000
  )

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
    'atomically replaces a fresh POSIX lock only after the execution host changes',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'orca-install-lock-reboot-'))
      try {
        const lockDir = join(root, '.install-lock')
        const acquire = tryCreateInstallLockCommand(nativePosix, lockDir)
        const recover = tryStealInstallLockCommand(nativePosix, lockDir, 20 * 60)

        expect((await runShellCommand(acquire)).trim()).toBe('OK')
        const currentBootId = readFileSync(join(lockDir, '.boot-id'), 'utf8').trim()
        expect(currentBootId).toMatch(/^(?:darwin|linux):/u)
        expect((await runShellCommand(recover)).trim()).toBe('BUSY')

        const previousBootId =
          nativePosix.os === 'darwin' ? 'darwin:0' : 'linux:00000000-0000-0000-0000-000000000000:0'
        writeFileSync(join(lockDir, '.boot-id'), previousBootId)
        const outputs = await Promise.all(
          Array.from({ length: 32 }, () => runShellCommand(recover))
        )

        expect(outputs.filter((output) => output.trim() === 'REBOOT_OK')).toHaveLength(1)
        expect(readFileSync(join(lockDir, '.boot-id'), 'utf8').trim()).toBe(currentBootId)
        expect(readdirSync(root).some((name) => name.includes('.tombstone'))).toBe(false)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  )

  it.runIf(process.platform !== 'win32')(
    'keeps a fresh legacy POSIX lock when no boot identity is available',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'orca-install-lock-legacy-'))
      try {
        const lockDir = join(root, '.install-lock')
        mkdirSync(lockDir)

        const output = await runShellCommand(
          tryStealInstallLockCommand(nativePosix, lockDir, 20 * 60)
        )

        expect(output.trim()).toBe('BUSY')
        expect(existsSync(lockDir)).toBe(true)

        writeFileSync(join(lockDir, '.boot-id'), 'partial')
        expect(
          (await runShellCommand(tryStealInstallLockCommand(nativePosix, lockDir, 20 * 60))).trim()
        ).toBe('BUSY')
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
})
