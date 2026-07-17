import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const projectRoot = resolve(import.meta.dirname, '../..')
const sourceRoot = join(projectRoot, 'native', 'windows-ssh-no-input-launcher')
const buildScript = join(
  projectRoot,
  'config',
  'scripts',
  'build-windows-ssh-no-input-launcher.mjs'
)
const itWindows = process.platform === 'win32' ? it : it.skip
let fixtureRoot
let launcherPath
let childFixturePath
let handleProbePath
let consoleEofProbePath

beforeAll(() => {
  if (process.platform !== 'win32') {
    return
  }
  fixtureRoot = mkdtempSync(join(tmpdir(), 'orca ssh no-input launcher '))
  launcherPath = join(fixtureRoot, 'orca-ssh-no-input.exe')
  childFixturePath = join(fixtureRoot, 'child-fixture.cjs')
  handleProbePath = join(fixtureRoot, 'windows-launcher-handle-probe.exe')
  consoleEofProbePath = join(fixtureRoot, 'windows-console-eof-probe.exe')
  writeFileSync(childFixturePath, childFixtureSource, 'utf8')
  const build = spawnSync(process.execPath, [buildScript, '--output', launcherPath], {
    cwd: projectRoot,
    encoding: 'utf8'
  })
  expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0)

  const compilerPath = findFrameworkCompiler(process.env)
  expect(compilerPath).not.toBeNull()
  const probeSource = join(
    projectRoot,
    'native',
    'windows-ssh-no-input-launcher-test',
    'WindowsLauncherHandleProbe.cs'
  )
  const probeBuild = spawnSync(
    compilerPath,
    [
      '/nologo',
      '/target:exe',
      '/platform:anycpu',
      '/optimize+',
      '/warnaserror+',
      `/out:${handleProbePath}`,
      probeSource
    ],
    { cwd: projectRoot, encoding: 'utf8' }
  )
  expect(probeBuild.status, `${probeBuild.stdout}\n${probeBuild.stderr}`).toBe(0)

  const eofProbeSource = join(
    projectRoot,
    'native',
    'windows-ssh-no-input-launcher-test',
    'WindowsConsoleEofProbe.cs'
  )
  const eofProbeBuild = spawnSync(
    compilerPath,
    [
      '/nologo',
      '/target:exe',
      '/platform:anycpu',
      '/optimize+',
      '/warnaserror+',
      `/out:${consoleEofProbePath}`,
      eofProbeSource
    ],
    { cwd: projectRoot, encoding: 'utf8' }
  )
  expect(eofProbeBuild.status, `${eofProbeBuild.stdout}\n${eofProbeBuild.stderr}`).toBe(0)
}, 20_000)

afterAll(() => {
  if (fixtureRoot) {
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
})

describe('Windows SSH no-input launcher', () => {
  it('keeps the artifact source scoped to the reviewed Win32 boundary', () => {
    const processSource = readFileSync(join(sourceRoot, 'WindowsSshChildProcess.cs'), 'utf8')
    const programSource = readFileSync(join(sourceRoot, 'OrcaSshNoInputLauncher.cs'), 'utf8')
    const consoleSource = readFileSync(join(sourceRoot, 'WindowsPrivateConsoleInput.cs'), 'utf8')
    const outputSource = readFileSync(join(sourceRoot, 'WindowsBoundedOutputFiles.cs'), 'utf8')

    expect(processSource).toContain('ProcThreadAttributeHandleList')
    expect(processSource).toContain('IntPtr.Size * 3')
    expect(processSource).toContain('CreateSuspended')
    expect(processSource).not.toContain('CreateNoWindow')
    expect(processSource).toContain('JobObjectLimitKillOnJobClose')
    expect(processSource).toContain('WaitForSingleObject')
    expect(processSource).toContain('OutputLimitPollMilliseconds = 50')
    expect(processSource).toContain('JobSettlementTimeoutMilliseconds = 5000')
    expect(processSource).toContain('TerminateJobObject')
    expect(processSource).toContain('diagnosticTimeoutMilliseconds')
    expect(programSource).toContain('--diagnostic-timeout-ms')
    expect(programSource).toContain('diagnosticTimeoutMilliseconds > 60000')
    expect(processSource).toContain('outputs.EnsureWithinLimits()')
    expect(processSource).toContain('outputs.ReplayOutputs()')
    expect(processSource).not.toContain('WaitForMultipleObjects')
    expect(processSource).toContain('if (processStarted && !assignedToJob)')
    expect(consoleSource).toContain('AllocConsole()')
    expect(consoleSource).toContain('"CONIN$"')
    expect(consoleSource).toContain('ShowWindow(window, SwHide)')
    expect(consoleSource).toContain('WriteConsoleInput')
    expect(consoleSource).toContain('console.QueueEndOfInput()')
    expect(processSource).toContain('WindowsPrivateConsoleInput.Create()')
    expect(consoleSource.indexOf('console.QueueEndOfInput()')).toBeLessThan(
      consoleSource.indexOf('return console;')
    )
    expect(processSource.indexOf('WindowsPrivateConsoleInput.Create()')).toBeLessThan(
      processSource.indexOf('CreateProcess(')
    )
    expect(outputSource).toContain('MaxCapturedBytes = 16 * 1024 * 1024')
    expect(outputSource).toContain('FileOptions.DeleteOnClose')
    expect(outputSource).toContain('FileMode.CreateNew')
    expect(outputSource).toContain('ReplayBufferBytes = 64 * 1024')
    expect(outputSource).toContain('SetHandleInformation')
    expect(processSource).toContain('outputs.CloseChildEndsInParent()')
  })

  it.skipIf(process.platform === 'win32')(
    'fails closed when compilation is attempted away from Windows',
    () => {
      const result = spawnSync(process.execPath, [buildScript], {
        cwd: projectRoot,
        encoding: 'utf8'
      })

      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('requires a Windows host')
    }
  )

  itWindows('preserves exact arguments and qualifies private-console stdin', () => {
    const args = ['', 'space value', 'quote"value', 'trailing slash\\', 'line one\nline two', '雪']
    const result = runLauncher('arguments-and-stdin', args, {
      input: Buffer.from('this input must not reach the SSH child', 'utf8')
    })

    expect(result.status, result.stderr.toString('utf8')).toBe(0)
    expect(JSON.parse(result.stdout.toString('utf8'))).toEqual({
      args,
      stdinIsTTY: true
    })
  })

  itWindows('queues cooked private-console EOF before child execution', () => {
    const result = spawnSync(launcherPath, [consoleEofProbePath], {
      cwd: fixtureRoot,
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true
    })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toBe('ORCA-PRIVATE-CONSOLE-EOF bytes=0')
  })

  itWindows('preserves binary stdout and stderr and propagates the child exit code', () => {
    const binary = runLauncher('binary-output')
    expect(binary.status).toBe(0)
    expect(binary.stdout).toEqual(Buffer.from([0x00, 0xff, 0x10, 0x0a, 0x80]))
    expect(binary.stderr).toEqual(Buffer.from([0xfe, 0x00, 0x7f, 0x0d, 0x0a]))

    const exited = runLauncher('exit-code', ['37'])
    expect(exited.status).toBe(37)
  })

  itWindows('fails closed above the output ceiling and removes capture files', () => {
    const capturesBefore = listCaptureFiles()
    const result = runLauncher('overflow-output')

    expect(result.status).toBe(1)
    expect(result.stdout).toEqual(Buffer.alloc(0))
    expect(result.stderr.toString('utf8')).toContain(
      'SSH stdout exceeded the 16 MiB diagnostic capture limit.'
    )
    expect(listCaptureFiles()).toEqual(capturesBefore)
  })

  itWindows('removes successful capture files after exact binary replay', () => {
    const capturesBefore = listCaptureFiles()
    const result = runLauncher('binary-output')

    expect(result.status).toBe(0)
    expect(listCaptureFiles()).toEqual(capturesBefore)
  })

  itWindows(
    'terminates the child job and replays bounded output at the diagnostic deadline',
    { timeout: 10_000 },
    async () => {
      const capturesBefore = listCaptureFiles()
      const pidPath = join(fixtureRoot, 'timed-out-child.pid')
      const result = runLauncher('hold', [pidPath], {}, 250)
      const childPid = Number.parseInt(readFileSync(pidPath, 'utf8'), 10)

      expect(result.status).toBe(1)
      expect(result.stdout.toString('utf8')).toBe('ORCA-HOLD-STDOUT')
      expect(result.stderr.toString('utf8')).toContain('ORCA-HOLD-STDERR')
      expect(result.stderr.toString('utf8')).toContain(
        'SSH child reached the 250 ms diagnostic timeout.'
      )
      await waitForProcessExit(childPid, 5_000)
      expect(listCaptureFiles()).toEqual(capturesBefore)
    }
  )

  itWindows('does not leak an unrelated inheritable parent handle into the child', () => {
    const result = spawnSync(handleProbePath, [launcherPath], {
      cwd: fixtureRoot,
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true
    })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('ORCA-NO-INHERITED-HANDLE-LEAK')
  })

  itWindows(
    'kills the child job and settles boundedly when the launcher is cancelled',
    { timeout: 15_000 },
    async () => {
      const startedAt = performance.now()
      const capturesBefore = listCaptureFiles()
      const pidPath = join(fixtureRoot, 'held-child.pid')
      const child = spawn(launcherPath, [process.execPath, childFixturePath, 'hold', pidPath], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      })
      const childPid = await readPidFile(pidPath, 5_000)
      expect(Number.isInteger(childPid)).toBe(true)

      const closePromise = waitForClose(child, 5_000)
      expect(child.kill('SIGKILL')).toBe(true)
      await closePromise
      await waitForProcessExit(childPid, 5_000)
      await waitForCaptureFiles(capturesBefore, 5_000)
      expect(performance.now() - startedAt).toBeLessThan(10_000)
    }
  )
})

function runLauncher(mode, args = [], options = {}, diagnosticTimeoutMs = null) {
  const diagnosticArgs =
    diagnosticTimeoutMs == null ? [] : ['--diagnostic-timeout-ms', String(diagnosticTimeoutMs)]
  return spawnSync(
    launcherPath,
    [...diagnosticArgs, process.execPath, childFixturePath, mode, ...args],
    {
      cwd: fixtureRoot,
      encoding: null,
      timeout: 10_000,
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
      ...options
    }
  )
}

function listCaptureFiles() {
  return readdirSync(tmpdir())
    .filter((name) => name.startsWith('orca-ssh-no-input-') && name.endsWith('.capture'))
    .sort()
}

function findFrameworkCompiler(env) {
  const windowsDirectory = env.WINDIR ?? env.SystemRoot
  if (!windowsDirectory) {
    return null
  }
  return (
    [
      join(windowsDirectory, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
      join(windowsDirectory, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe')
    ].find((candidate) => existsSync(candidate)) ?? null
  )
}

async function readPidFile(path, timeoutMs) {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    if (existsSync(path)) {
      return Number.parseInt(readFileSync(path, 'utf8'), 10)
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25))
  }
  throw new Error('Timed out waiting for child PID file.')
}

async function waitForCaptureFiles(expected, timeoutMs) {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    if (JSON.stringify(listCaptureFiles()) === JSON.stringify(expected)) {
      return
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25))
  }
  throw new Error('Launcher capture files survived bounded cancellation cleanup.')
}

function waitForClose(child, timeoutMs) {
  return new Promise((resolveClose, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('Launcher cancellation did not settle.')),
      timeoutMs
    )
    child.once('close', () => {
      clearTimeout(timeout)
      resolveClose()
    })
    child.once('error', reject)
  })
}

async function waitForProcessExit(pid, timeoutMs) {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25))
  }
  throw new Error(`Launcher child ${pid} survived job-owned cancellation.`)
}

const childFixtureSource = String.raw`const mode = process.argv[2]
if (mode === 'arguments-and-stdin') {
  process.stdout.write(JSON.stringify({
    args: process.argv.slice(3),
    stdinIsTTY: process.stdin.isTTY === true
  }))
} else if (mode === 'binary-output') {
  process.stdout.write(Buffer.from([0x00, 0xff, 0x10, 0x0a, 0x80]))
  process.stderr.write(Buffer.from([0xfe, 0x00, 0x7f, 0x0d, 0x0a]))
} else if (mode === 'exit-code') {
  process.exit(Number.parseInt(process.argv[3], 10))
} else if (mode === 'overflow-output') {
  const chunk = Buffer.alloc(1024 * 1024, 0xa5)
  for (let index = 0; index < 17; index += 1) {
    process.stdout.write(chunk)
  }
} else if (mode === 'hold') {
  require('node:fs').writeFileSync(process.argv[3], String(process.pid))
  process.stdout.write('ORCA-HOLD-STDOUT')
  process.stderr.write('ORCA-HOLD-STDERR')
  setInterval(() => {}, 1000)
} else {
  process.exit(99)
}
`
