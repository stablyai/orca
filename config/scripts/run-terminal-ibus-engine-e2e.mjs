import { spawn, spawnSync } from 'node:child_process'
import { closeSync, copyFileSync, mkdirSync, mkdtempSync, openSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  defaultTerminalIbusEngineId,
  resolveTerminalIbusEngineProfile,
  terminalIbusEngineIds
} from './terminal-ibus-engine-profiles.mjs'

const projectDir = path.resolve(import.meta.dirname, '../..')
const scriptPath = import.meta.filename
const insideSessionFlag = '--inside-session'
const engineFlagPrefix = '--engine='
const nativeSpecPath = 'tests/e2e/terminal-ibus-engine-native.spec.ts'
const processStopTimeoutMs = 5_000
const processKillTimeoutMs = 1_000

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)))
  })
}

function processGroupMembers(processGroupId) {
  const result = spawnSync('ps', ['-o', 'pid=,ppid=,pgid=,comm=', '-g', String(processGroupId)], {
    encoding: 'utf8'
  })
  if (result.status !== 0) {
    return []
  }
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

async function stopOwnedProcessGroup(processGroupId) {
  let members = processGroupMembers(processGroupId)
  if (members.length === 0) {
    return []
  }
  console.error(
    `[terminal-ime] stopping owned process group ${processGroupId}: ${members.join('; ')}`
  )
  try {
    process.kill(-processGroupId, 'SIGTERM')
  } catch (error) {
    if (error?.code !== 'ESRCH') {
      throw error
    }
  }

  const deadline = Date.now() + processStopTimeoutMs
  while (Date.now() < deadline) {
    members = processGroupMembers(processGroupId)
    if (members.length === 0) {
      return []
    }
    await delay(100)
  }

  try {
    process.kill(-processGroupId, 'SIGKILL')
  } catch (error) {
    if (error?.code !== 'ESRCH') {
      throw error
    }
  }
  const killDeadline = Date.now() + processKillTimeoutMs
  do {
    members = processGroupMembers(processGroupId)
    if (members.length === 0) {
      return []
    }
    await delay(100)
  } while (Date.now() < killDeadline)
  return members
}

function commandOutput(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : result.stderr.trim()
}

function selectedEngineId() {
  const flag = process.argv.find((argument) => argument.startsWith(engineFlagPrefix))
  const engineId =
    flag?.slice(engineFlagPrefix.length) ||
    process.env.ORCA_E2E_NATIVE_IBUS_ENGINE ||
    defaultTerminalIbusEngineId
  resolveTerminalIbusEngineProfile(engineId)
  return engineId
}

function configureEngine(profile) {
  for (const [schemaId, key, value] of profile.gsettings) {
    const result = spawnSync('gsettings', ['set', schemaId, key, value], { encoding: 'utf8' })
    if (result.status !== 0) {
      throw new Error(`Failed to configure ${schemaId} ${key}: ${result.stderr.trim()}`)
    }
  }
}

async function waitForEngine(ibusProcess, profile) {
  const deadline = Date.now() + 15_000
  let lastFailure = ''
  while (Date.now() < deadline) {
    if (ibusProcess.exitCode !== null) {
      throw new Error(`ibus-daemon exited early with code ${ibusProcess.exitCode}`)
    }
    const result = spawnSync('ibus', ['engine', profile.ibusEngineName], {
      encoding: 'utf8',
      stdio: 'pipe'
    })
    if (result.status === 0) {
      return
    }
    lastFailure = (result.stderr || result.stdout || '').trim()
    await delay(100)
  }
  // Why: the engine name a package registers is not always its apt suffix, so the
  // available list is the only thing that tells you which of the two is wrong.
  const available = commandOutput('ibus', ['list-engine'])
  throw new Error(
    `Timed out while selecting the IBus ${profile.ibusEngineName} engine.\n` +
      `Last 'ibus engine' failure: ${lastFailure || '(no output)'}\n` +
      `Engines ibus reports as available:\n${available}`
  )
}

async function runInsideSession(engineId, evidenceDir) {
  const profile = resolveTerminalIbusEngineProfile(engineId)
  const ibusLogPath = path.join(evidenceDir, 'ibus-daemon.log')
  const ibusLogFd = openSync(ibusLogPath, 'w')
  const windowManagerLogPath = path.join(evidenceDir, 'xfwm4.log')
  const windowManagerLogFd = openSync(windowManagerLogPath, 'w')
  const evidence = {
    display: process.env.DISPLAY ?? null,
    engineId,
    ibusDaemonPid: null,
    ibusGroupBeforeCleanup: [],
    ibusGroupAfterCleanup: [],
    playwrightPid: null,
    windowManagerPid: null,
    windowManagerGroupAfterCleanup: []
  }
  let ibusProcess
  let windowManagerProcess
  let testExitCode = 1

  try {
    configureEngine(profile)
    windowManagerProcess = spawn('xfwm4', ['--compositor=off'], {
      detached: true,
      env: process.env,
      stdio: ['ignore', windowManagerLogFd, windowManagerLogFd]
    })
    if (!windowManagerProcess.pid) {
      throw new Error('xfwm4 did not return a PID')
    }
    evidence.windowManagerPid = windowManagerProcess.pid
    console.error(`[terminal-ime] started xfwm4 PID ${windowManagerProcess.pid}`)

    ibusProcess = spawn(
      'ibus-daemon',
      ['--xim', '--verbose', '--panel=disable', '--emoji-extension=disable'],
      {
        detached: true,
        env: process.env,
        stdio: ['ignore', ibusLogFd, ibusLogFd]
      }
    )
    if (!ibusProcess.pid) {
      throw new Error('ibus-daemon did not return a PID')
    }
    evidence.ibusDaemonPid = ibusProcess.pid
    console.error(`[terminal-ime] started ibus-daemon PID ${ibusProcess.pid}`)
    await waitForEngine(ibusProcess, profile)
    console.error(`[terminal-ime] IBus version: ${commandOutput('ibus', ['version'])}`)
    console.error(`[terminal-ime] IBus engine: ${commandOutput('ibus', ['engine'])}`)
    for (const [schemaId, key] of profile.gsettings) {
      console.error(
        `[terminal-ime] ${schemaId} ${key}: ${commandOutput('gsettings', ['get', schemaId, key])}`
      )
    }
    evidence.ibusGroupBeforeCleanup = processGroupMembers(ibusProcess.pid)
    console.error(`[terminal-ime] owned IBus group: ${evidence.ibusGroupBeforeCleanup.join('; ')}`)

    const testProcess = spawn(
      process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
      ['run', 'test:e2e:headful', '--workers=1', '--', nativeSpecPath],
      {
        cwd: projectDir,
        env: {
          ...process.env,
          ORCA_E2E_FORWARD_APP_LOGS: '1',
          ORCA_E2E_NATIVE_IBUS_ENGINE: engineId
        },
        stdio: 'inherit'
      }
    )
    if (!testProcess.pid) {
      throw new Error('Playwright did not return a PID')
    }
    evidence.playwrightPid = testProcess.pid
    console.error(`[terminal-ime] started Playwright PID ${testProcess.pid}`)
    testExitCode = await waitForExit(testProcess)
  } finally {
    if (ibusProcess?.pid) {
      evidence.ibusGroupBeforeCleanup = processGroupMembers(ibusProcess.pid)
      evidence.ibusGroupAfterCleanup = await stopOwnedProcessGroup(ibusProcess.pid)
    }
    if (windowManagerProcess?.pid) {
      evidence.windowManagerGroupAfterCleanup = await stopOwnedProcessGroup(
        windowManagerProcess.pid
      )
    }
    closeSync(ibusLogFd)
    closeSync(windowManagerLogFd)
    mkdirSync(path.join(projectDir, 'test-results'), { recursive: true })
    copyFileSync(
      ibusLogPath,
      path.join(projectDir, 'test-results', `terminal-ibus-${engineId}-native-ibus.log`)
    )
    copyFileSync(
      windowManagerLogPath,
      path.join(projectDir, 'test-results', `terminal-ibus-${engineId}-native-xfwm4.log`)
    )
    writeFileSync(
      path.join(projectDir, 'test-results', `terminal-ibus-${engineId}-native-processes.json`),
      `${JSON.stringify(evidence, null, 2)}\n`
    )
  }

  if (evidence.ibusGroupAfterCleanup.length > 0) {
    throw new Error(
      `Owned IBus processes survived cleanup: ${evidence.ibusGroupAfterCleanup.join('; ')}`
    )
  }
  if (evidence.windowManagerGroupAfterCleanup.length > 0) {
    throw new Error(
      `Owned window-manager processes survived cleanup: ${evidence.windowManagerGroupAfterCleanup.join('; ')}`
    )
  }
  return testExitCode
}

async function runOuter(engineId) {
  if (process.platform !== 'linux') {
    throw new Error('The native IBus E2E runner requires Linux/X11')
  }
  console.error(
    `[terminal-ime] engine: ${engineId} (available: ${terminalIbusEngineIds().join(', ')})`
  )

  const evidenceDir = mkdtempSync(path.join(os.tmpdir(), 'orca-terminal-ime-e2e-'))
  const runtimeDir = path.join(evidenceDir, 'runtime')
  mkdirSync(runtimeDir, { mode: 0o700 })
  mkdirSync(path.join(evidenceDir, 'config'))
  mkdirSync(path.join(evidenceDir, 'cache'))
  console.error(`[terminal-ime] evidence directory: ${evidenceDir}`)

  const sessionProcess = spawn(
    'xvfb-run',
    [
      '--auto-servernum',
      'dbus-run-session',
      '--',
      process.execPath,
      scriptPath,
      insideSessionFlag,
      evidenceDir
    ],
    {
      cwd: projectDir,
      detached: true,
      env: {
        ...process.env,
        GTK_IM_MODULE: 'ibus',
        IBUS_ENABLE_SYNC_MODE: '1',
        LANG: process.env.LANG || 'C.UTF-8',
        ORCA_E2E_NATIVE_IBUS_ENGINE: engineId,
        QT_IM_MODULE: 'ibus',
        XDG_CACHE_HOME: path.join(evidenceDir, 'cache'),
        XDG_CONFIG_HOME: path.join(evidenceDir, 'config'),
        XDG_RUNTIME_DIR: runtimeDir,
        XMODIFIERS: '@im=ibus'
      },
      stdio: 'inherit'
    }
  )
  if (!sessionProcess.pid) {
    throw new Error('xvfb-run did not return a PID')
  }
  console.error(`[terminal-ime] started isolated X11 session PID ${sessionProcess.pid}`)
  const exitCode = await waitForExit(sessionProcess)
  const remaining = await stopOwnedProcessGroup(sessionProcess.pid)
  if (remaining.length > 0) {
    throw new Error(`Owned X11 session processes survived cleanup: ${remaining.join('; ')}`)
  }
  return exitCode
}

const insideSession = process.argv[2] === insideSessionFlag
try {
  const engineId = selectedEngineId()
  if (insideSession && !process.argv[3]) {
    throw new Error(`${insideSessionFlag} requires an evidence directory argument`)
  }
  process.exitCode = insideSession
    ? await runInsideSession(engineId, process.argv[3])
    : await runOuter(engineId)
} catch (error) {
  console.error(`[terminal-ime] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
