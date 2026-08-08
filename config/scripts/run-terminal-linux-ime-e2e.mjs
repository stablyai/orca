import { spawn, spawnSync } from 'node:child_process'
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const projectDir = path.resolve(import.meta.dirname, '../..')
const scriptPath = import.meta.filename
const insideSessionFlag = '--inside-session'
const processStopTimeoutMs = 5_000
const processKillTimeoutMs = 1_000
const inputFramework = process.env.ORCA_E2E_NATIVE_IME ?? 'ibus'
const displayServer = process.env.ORCA_E2E_NATIVE_DISPLAY_SERVER ?? 'x11'
const isWayland = displayServer === 'wayland'

if (!['ibus', 'fcitx5'].includes(inputFramework)) {
  throw new Error(`Unsupported native IME framework: ${inputFramework}`)
}
if (!['wayland', 'x11'].includes(displayServer)) {
  throw new Error(`Unsupported native display server: ${displayServer}`)
}
if (isWayland && inputFramework !== 'fcitx5') {
  throw new Error('Native Wayland coverage currently requires Fcitx5')
}

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

function configureHangulEngine() {
  for (const [key, value] of [
    ['initial-input-mode', 'hangul'],
    ['hangul-keyboard', '2']
  ]) {
    const result = spawnSync(
      'gsettings',
      ['set', 'org.freedesktop.ibus.engine.hangul', key, value],
      { encoding: 'utf8' }
    )
    if (result.status !== 0) {
      throw new Error(`Failed to configure IBus Hangul ${key}: ${result.stderr.trim()}`)
    }
  }
}

function configureFcitxProfile(evidenceDir) {
  const fcitxConfigDir = path.join(evidenceDir, 'config', 'fcitx5')
  mkdirSync(fcitxConfigDir, { recursive: true })
  writeFileSync(
    path.join(fcitxConfigDir, 'profile'),
    `[Groups/0]
Name=Default
Default Layout=us
DefaultIM=hangul

[Groups/0/Items/0]
Name=keyboard-us
Layout=

[Groups/0/Items/1]
Name=hangul
Layout=

[Groups/0/Items/2]
Name=pinyin
Layout=

[GroupOrder]
0=Default
`
  )
}

async function waitForIbusEngine(ibusProcess, engine) {
  const busDeadline = Date.now() + 15_000
  while (Date.now() < busDeadline) {
    if (ibusProcess.exitCode !== null) {
      throw new Error(`ibus-daemon exited early with code ${ibusProcess.exitCode}`)
    }
    const result = spawnSync('ibus', ['engine'], { encoding: 'utf8' })
    if (result.status === 0) {
      break
    }
    await delay(100)
  }

  spawnSync('ibus', ['engine', engine], { stdio: 'pipe' })
  const engineDeadline = Date.now() + 15_000
  while (Date.now() < engineDeadline) {
    const result = spawnSync('ibus', ['engine'], { encoding: 'utf8' })
    if (result.status === 0 && result.stdout.trim() === engine) {
      return
    }
    await delay(100)
  }
  throw new Error(`Timed out while selecting the IBus ${engine} engine`)
}

async function waitForFcitx(fcitxProcess) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (fcitxProcess.exitCode !== null) {
      throw new Error(`fcitx5 exited early with code ${fcitxProcess.exitCode}`)
    }
    const owner = spawnSync(
      'gdbus',
      [
        'call',
        '--session',
        '--dest',
        'org.freedesktop.DBus',
        '--object-path',
        '/org/freedesktop/DBus',
        '--method',
        'org.freedesktop.DBus.NameHasOwner',
        'org.fcitx.Fcitx5'
      ],
      { encoding: 'utf8' }
    )
    if (owner.status === 0 && owner.stdout.includes('true')) {
      for (const engine of ['hangul', 'pinyin']) {
        const addon = spawnSync('fcitx5-remote', ['-m', engine], { encoding: 'utf8' })
        if (addon.status !== 0 || addon.stdout.trim().length === 0) {
          throw new Error(`Fcitx5 input method is unavailable: ${engine}`)
        }
      }
      return
    }
    await delay(100)
  }
  throw new Error('Timed out while starting Fcitx5')
}

async function waitForWaylandCompositor(compositorProcess) {
  const runtimeDir = process.env.XDG_RUNTIME_DIR
  const display = process.env.WAYLAND_DISPLAY
  if (!runtimeDir || !display) {
    throw new Error('Native Wayland coverage requires XDG_RUNTIME_DIR and WAYLAND_DISPLAY')
  }
  const socketPath = path.isAbsolute(display) ? display : path.join(runtimeDir, display)
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (compositorProcess.exitCode !== null) {
      throw new Error(`sway exited early with code ${compositorProcess.exitCode}`)
    }
    if (existsSync(socketPath)) {
      return
    }
    await delay(100)
  }
  throw new Error(`Timed out while waiting for Wayland socket: ${socketPath}`)
}

async function runInsideSession(evidenceDir) {
  const inputMethodLogPath = path.join(evidenceDir, `${inputFramework}-daemon.log`)
  const inputMethodLogFd = openSync(inputMethodLogPath, 'w')
  const windowManagerName = isWayland ? 'sway' : 'xfwm4'
  const displayEvidenceSuffix = isWayland ? '-wayland' : ''
  const windowManagerLogPath = path.join(evidenceDir, `${windowManagerName}.log`)
  const windowManagerLogFd = openSync(windowManagerLogPath, 'w')
  const evidence = {
    display: process.env.DISPLAY ?? null,
    displayServer,
    inputFramework,
    inputMethodDaemonPid: null,
    inputMethodGroupBeforeCleanup: [],
    inputMethodGroupAfterCleanup: [],
    playwrightPid: null,
    swaySocket: null,
    waylandDisplay: process.env.WAYLAND_DISPLAY ?? null,
    windowManagerPid: null,
    windowManagerGroupAfterCleanup: []
  }
  let inputMethodProcess
  let windowManagerProcess
  let testExitCode = 1

  try {
    if (inputFramework === 'ibus') {
      configureHangulEngine()
    } else {
      configureFcitxProfile(evidenceDir)
    }
    windowManagerProcess = spawn(
      windowManagerName,
      isWayland ? ['-c', '/dev/null'] : ['--compositor=off'],
      {
        detached: true,
        env: process.env,
        stdio: ['ignore', windowManagerLogFd, windowManagerLogFd]
      }
    )
    if (!windowManagerProcess.pid) {
      throw new Error(`${windowManagerName} did not return a PID`)
    }
    evidence.windowManagerPid = windowManagerProcess.pid
    console.error(`[terminal-ime] started ${windowManagerName} PID ${windowManagerProcess.pid}`)
    if (isWayland) {
      process.env.SWAYSOCK = path.join(
        process.env.XDG_RUNTIME_DIR,
        `sway-ipc.${process.getuid()}.${windowManagerProcess.pid}.sock`
      )
      evidence.swaySocket = process.env.SWAYSOCK
      await waitForWaylandCompositor(windowManagerProcess)
    }

    const inputMethodCommand = inputFramework === 'ibus' ? 'ibus-daemon' : 'fcitx5'
    const inputMethodArgs =
      inputFramework === 'ibus'
        ? ['--xim', '--verbose', '--panel=disable', '--emoji-extension=disable']
        : isWayland
          ? []
          : ['--disable=wayland']
    inputMethodProcess = spawn(inputMethodCommand, inputMethodArgs, {
      detached: true,
      env: process.env,
      stdio: ['ignore', inputMethodLogFd, inputMethodLogFd]
    })
    if (!inputMethodProcess.pid) {
      throw new Error(`${inputMethodCommand} did not return a PID`)
    }
    evidence.inputMethodDaemonPid = inputMethodProcess.pid
    console.error(`[terminal-ime] started ${inputMethodCommand} PID ${inputMethodProcess.pid}`)
    if (inputFramework === 'ibus') {
      await waitForIbusEngine(inputMethodProcess, 'hangul')
      await waitForIbusEngine(inputMethodProcess, 'libpinyin')
      await waitForIbusEngine(inputMethodProcess, 'hangul')
      console.error(`[terminal-ime] IBus version: ${commandOutput('ibus', ['version'])}`)
      console.error(`[terminal-ime] IBus engine: ${commandOutput('ibus', ['engine'])}`)
      console.error(
        `[terminal-ime] Hangul initial mode: ${commandOutput('gsettings', [
          'get',
          'org.freedesktop.ibus.engine.hangul',
          'initial-input-mode'
        ])}`
      )
      console.error(
        `[terminal-ime] Hangul keyboard: ${commandOutput('gsettings', [
          'get',
          'org.freedesktop.ibus.engine.hangul',
          'hangul-keyboard'
        ])}`
      )
    } else {
      await waitForFcitx(inputMethodProcess)
      console.error(`[terminal-ime] Fcitx5 version: ${commandOutput('fcitx5', ['--version'])}`)
    }
    evidence.inputMethodGroupBeforeCleanup = processGroupMembers(inputMethodProcess.pid)
    console.error(
      `[terminal-ime] owned ${inputFramework} group: ${evidence.inputMethodGroupBeforeCleanup.join('; ')}`
    )

    const testProcess = spawn(
      process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
      [
        'run',
        'test:e2e:headful',
        '--workers=1',
        '--',
        'tests/e2e/terminal-linux-ime-native.spec.ts'
      ],
      {
        cwd: projectDir,
        env: {
          ...process.env,
          ORCA_E2E_FORWARD_APP_LOGS: '1',
          ORCA_E2E_NATIVE_IME: inputFramework
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
    if (inputMethodProcess?.pid) {
      evidence.inputMethodGroupBeforeCleanup = processGroupMembers(inputMethodProcess.pid)
      evidence.inputMethodGroupAfterCleanup = await stopOwnedProcessGroup(inputMethodProcess.pid)
    }
    if (windowManagerProcess?.pid) {
      evidence.windowManagerGroupAfterCleanup = await stopOwnedProcessGroup(
        windowManagerProcess.pid
      )
    }
    closeSync(inputMethodLogFd)
    closeSync(windowManagerLogFd)
    mkdirSync(path.join(projectDir, 'test-results'), { recursive: true })
    copyFileSync(
      inputMethodLogPath,
      path.join(projectDir, 'test-results', `terminal-${inputFramework}-native-daemon.log`)
    )
    copyFileSync(
      windowManagerLogPath,
      path.join(
        projectDir,
        'test-results',
        `terminal-${inputFramework}-native${displayEvidenceSuffix}-${windowManagerName}.log`
      )
    )
    writeFileSync(
      path.join(
        projectDir,
        'test-results',
        `terminal-${inputFramework}-native${displayEvidenceSuffix}-processes.json`
      ),
      `${JSON.stringify(evidence, null, 2)}\n`
    )
  }

  if (evidence.inputMethodGroupAfterCleanup.length > 0) {
    throw new Error(
      `Owned ${inputFramework} processes survived cleanup: ${evidence.inputMethodGroupAfterCleanup.join('; ')}`
    )
  }
  if (evidence.windowManagerGroupAfterCleanup.length > 0) {
    throw new Error(
      `Owned window-manager processes survived cleanup: ${evidence.windowManagerGroupAfterCleanup.join('; ')}`
    )
  }
  return testExitCode
}

async function runOuter() {
  if (process.platform !== 'linux') {
    throw new Error('The native Linux IME E2E runner requires Linux')
  }

  const evidenceDir = mkdtempSync(path.join(os.tmpdir(), 'orca-terminal-ime-e2e-'))
  const runtimeDir = path.join(evidenceDir, 'runtime')
  mkdirSync(runtimeDir, { mode: 0o700 })
  mkdirSync(path.join(evidenceDir, 'config'))
  mkdirSync(path.join(evidenceDir, 'cache'))
  console.error(`[terminal-ime] evidence directory: ${evidenceDir}`)

  const sessionCommand = isWayland ? 'dbus-run-session' : 'xvfb-run'
  const sessionArgs = isWayland
    ? ['--', process.execPath, scriptPath, insideSessionFlag, evidenceDir]
    : [
        '--auto-servernum',
        'dbus-run-session',
        '--',
        process.execPath,
        scriptPath,
        insideSessionFlag,
        evidenceDir
      ]
  const {
    DISPLAY: _display,
    GTK_IM_MODULE: _gtkImModule,
    QT_IM_MODULE: _qtImModule,
    XMODIFIERS: _xModifiers,
    ...waylandBaseEnv
  } = process.env
  void _display
  void _gtkImModule
  void _qtImModule
  void _xModifiers
  const sessionProcess = spawn(sessionCommand, sessionArgs, {
    cwd: projectDir,
    detached: true,
    env: {
      ...(isWayland ? waylandBaseEnv : process.env),
      ...(isWayland
        ? {
            ELECTRON_OZONE_PLATFORM_HINT: 'wayland',
            WAYLAND_DISPLAY: 'wayland-1',
            WLR_BACKENDS: 'headless',
            WLR_HEADLESS_OUTPUTS: '1',
            WLR_LIBINPUT_NO_DEVICES: '1',
            XDG_SESSION_TYPE: 'wayland'
          }
        : {
            GTK_IM_MODULE: inputFramework === 'fcitx5' ? 'fcitx' : 'ibus',
            ...(inputFramework === 'ibus' ? { IBUS_ENABLE_SYNC_MODE: '1' } : {}),
            QT_IM_MODULE: inputFramework === 'fcitx5' ? 'fcitx' : 'ibus',
            XMODIFIERS: inputFramework === 'fcitx5' ? '@im=fcitx' : '@im=ibus'
          }),
      LANG: process.env.LANG || 'C.UTF-8',
      XDG_CACHE_HOME: path.join(evidenceDir, 'cache'),
      XDG_CONFIG_HOME: path.join(evidenceDir, 'config'),
      XDG_RUNTIME_DIR: runtimeDir
    },
    stdio: 'inherit'
  })
  if (!sessionProcess.pid) {
    throw new Error(`${sessionCommand} did not return a PID`)
  }
  console.error(
    `[terminal-ime] started isolated ${displayServer} session PID ${sessionProcess.pid}`
  )
  const exitCode = await waitForExit(sessionProcess)
  const remaining = await stopOwnedProcessGroup(sessionProcess.pid)
  if (remaining.length > 0) {
    throw new Error(
      `Owned ${displayServer} session processes survived cleanup: ${remaining.join('; ')}`
    )
  }
  return exitCode
}

const insideSession = process.argv[2] === insideSessionFlag
try {
  if (insideSession && !process.argv[3]) {
    throw new Error(`${insideSessionFlag} requires an evidence directory argument`)
  }
  process.exitCode = insideSession ? await runInsideSession(process.argv[3]) : await runOuter()
} catch (error) {
  console.error(`[terminal-ime] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
