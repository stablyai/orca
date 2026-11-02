import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createObservedSetupCommand,
  SETUP_STATUS_FILE_ENV
} from '../../shared/observed-setup-launch'
import { SETUP_AGENT_SEQUENCE_SETUP_SCRIPT_ENV } from '../../shared/setup-agent-sequencing'
import { observeSetupStatus } from './prepared-setup-status'

const TEMP_DIRS: string[] = []
const stops: (() => void)[] = []
afterEach(() => {
  for (const stop of stops.splice(0)) {
    stop()
  }
  for (const dir of TEMP_DIRS.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-setup-status-test-'))
  TEMP_DIRS.push(dir)
  return dir
}

function observe(attemptId: string, directory = tempDir()) {
  const onStatus = vi.fn()
  const observation = observeSetupStatus({ attemptId, onStatus, directory })
  stops.push(observation.stop)
  return { ...observation, onStatus }
}

describe('Setup status leaves through a file the daemon owns', () => {
  it('reports exactly the bound attempt once, from a CRLF record too', async () => {
    const attemptId = randomUUID()
    const status = observe(attemptId)
    writeFileSync(status.path, `${randomUUID()}:0\n`)
    await status.check()
    expect(status.onStatus).not.toHaveBeenCalled()
    writeFileSync(status.path, `${attemptId}:3\r\n`)
    await vi.waitFor(() => expect(status.onStatus).toHaveBeenCalledExactlyOnceWith(3))
    // Reporting removed the directory; nothing after it can report again.
    expect(existsSync(dirname(status.path))).toBe(false)
  })

  it('never reports a status written after the launch settled', async () => {
    const attemptId = randomUUID()
    const status = observe(attemptId)
    status.stop()
    await vi.waitFor(() => expect(existsSync(dirname(status.path))).toBe(false))
    // A late wrapper finds no directory, so its write fails where the user never sees it.
    expect(() => writeFileSync(status.path, `${attemptId}:0\n`)).toThrow()
    await status.check()
    expect(status.onStatus).not.toHaveBeenCalled()
  })

  it
    .skipIf(process.platform === 'win32' || spawnSync('bash', ['--version']).status !== 0)
    .each([0, 7])(
    'POSIX wrapper writes exit %i atomically and keeps the runner path out of the command',
    async (code) => {
      const dir = tempDir()
      const runner = join(dir, 'setup runner.sh')
      writeFileSync(runner, `echo user setup output\nexit ${code}\n`)
      const attemptId = randomUUID()
      const launch = createObservedSetupCommand({
        runnerScriptPath: runner,
        platform: 'posix',
        attemptId
      })
      expect(launch.command).toBe(
        `bash -lc 'eval "\${${SETUP_AGENT_SEQUENCE_SETUP_SCRIPT_ENV}:?missing}"'`
      )
      const status = observe(attemptId)
      const result = spawnSync('/bin/sh', ['-c', launch.command], {
        env: {
          PATH: process.env.PATH,
          HOME: dir,
          ...launch.env,
          [SETUP_STATUS_FILE_ENV]: status.path
        },
        encoding: 'utf8'
      })
      expect(result.status).toBe(code)
      // The terminal sees only what Setup itself printed.
      expect(result.stdout).toBe('user setup output\n')
      expect(result.stderr).toBe('')
      await vi.waitFor(() => expect(status.onStatus).toHaveBeenCalledExactlyOnceWith(code))
    }
  )

  it('Windows launcher types only a fixed line and keeps the runner, attempt and status write in the environment', () => {
    const attemptId = randomUUID()
    const runner = 'C:\\Users\\me\\AppData\\Roaming\\orca\\setup runner.cmd'
    const launch = createObservedSetupCommand({
      runnerScriptPath: runner,
      platform: 'windows',
      attemptId
    })
    const encoded = /-EncodedCommand (\S+)$/.exec(launch.command)?.[1] ?? ''
    expect(Buffer.from(encoded, 'base64').toString('utf16le')).toBe(
      `Invoke-Expression $env:${SETUP_AGENT_SEQUENCE_SETUP_SCRIPT_ENV}`
    )
    expect(launch.command).not.toContain(attemptId)
    const script = launch.env[SETUP_AGENT_SEQUENCE_SETUP_SCRIPT_ENV]
    expect(script).toContain('$process.ExitCode')
    expect(script).toContain(`$env:${SETUP_STATUS_FILE_ENV}`)
    expect(script).toContain('Move-Item')
    expect(script).toContain(`'${attemptId}:'`)
    expect(script).toContain(`'${runner}'`)
  })

  it.skipIf(process.platform !== 'win32').each([0, 7])(
    'Windows wrapper writes exit %i through cmd and PowerShell',
    async (code) => {
      const dir = tempDir()
      const runner = join(dir, 'setup & runner.cmd')
      writeFileSync(runner, ['@echo off', 'echo user setup output', `exit /b ${code}`].join('\r\n'))
      const attemptId = randomUUID()
      const launch = createObservedSetupCommand({
        runnerScriptPath: runner,
        platform: 'windows',
        attemptId
      })
      const status = observe(attemptId)
      const child = spawn('cmd.exe', ['/d', '/s', '/c', launch.command], {
        env: { ...process.env, ...launch.env, [SETUP_STATUS_FILE_ENV]: status.path },
        windowsVerbatimArguments: true
      })
      const exitCode = await new Promise<number | null>((resolve) => child.on('exit', resolve))
      expect(exitCode).toBe(code)
      await vi.waitFor(() => expect(status.onStatus).toHaveBeenCalledExactlyOnceWith(code), {
        timeout: 10_000
      })
    },
    30_000
  )
})
