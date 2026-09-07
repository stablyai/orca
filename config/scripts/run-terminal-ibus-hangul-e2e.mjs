import { spawn, spawnSync } from 'node:child_process'
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  writeFileSync
} from 'node:fs'
import { verifyPlaywrightParticipation } from './verify-playwright-participation.mjs'
import os from 'node:os'
import path from 'node:path'
import {
  EXPECTED_NATIVE_IME_TESTS,
  IME_ENGAGEMENT_RECEIPT_ENV,
  verifyImeEngagementReceipts
} from './terminal-ime-engagement-receipt.mjs'

const projectDir = path.resolve(import.meta.dirname, '../..')
const scriptPath = import.meta.filename
const insideSessionFlag = '--inside-session'
const nestedWaylandFlag = '--nested-wayland'
const nestedWayland = process.argv.includes(nestedWaylandFlag)
const waylandTitle = 'a digit typed right after a Hangul syllable reaches the pty'
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

async function waitForHangulEngine(sessionProcess) {
  let lastError = ''
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (sessionProcess.exitCode !== null) {
      throw new Error(`IME session process exited early with code ${sessionProcess.exitCode}`)
    }
    if (
      nestedWayland &&
      !existsSync(path.join(process.env.XDG_RUNTIME_DIR, process.env.WAYLAND_DISPLAY))
    ) {
      await delay(100)
      continue
    }
    const result = spawnSync('ibus', ['engine', 'hangul'], { encoding: 'utf8' })
    lastError = result.stderr?.trim() || String(result.error ?? result.status)
    if (result.status === 0) {
      return
    }
    await delay(100)
  }
  throw new Error(`Timed out while selecting the IBus Hangul engine: ${lastError}`)
}

async function runInsideSession(evidenceDir) {
  const receiptPath = path.join(evidenceDir, 'ime-engagement-receipt.jsonl')
  const ibusLogPath = path.join(evidenceDir, 'ibus-daemon.log')
  const ibusLogFd = openSync(ibusLogPath, 'w')
  const windowManagerLogPath = path.join(
    evidenceDir,
    nestedWayland ? 'gnome-shell.log' : 'xfwm4.log'
  )
  const windowManagerLogFd = openSync(windowManagerLogPath, 'w')
  const evidence = {
    display: process.env.DISPLAY ?? null,
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
    configureHangulEngine()
    if (nestedWayland) {
      for (const [schema, key, value] of [
        ['org.gnome.desktop.interface', 'enable-animations', 'false'],
        ['org.gnome.desktop.input-sources', 'sources', "[('ibus', 'hangul')]"]
      ]) {
        const result = spawnSync('gsettings', ['set', schema, key, value], { encoding: 'utf8' })
        if (result.status !== 0) {
          throw new Error(`Failed to configure GNOME: ${result.stderr}`)
        }
      }
      windowManagerProcess = spawn(
        'gnome-shell',
        ['--nested', '--wayland', `--wayland-display=${process.env.WAYLAND_DISPLAY}`],
        {
          detached: true,
          env: process.env,
          stdio: ['ignore', windowManagerLogFd, windowManagerLogFd]
        }
      )
    } else {
      windowManagerProcess = spawn('xfwm4', ['--compositor=off'], {
        detached: true,
        env: process.env,
        stdio: ['ignore', windowManagerLogFd, windowManagerLogFd]
      })
    }
    if (!windowManagerProcess.pid) {
      throw new Error('Window manager did not return a PID')
    }
    evidence.windowManagerPid = windowManagerProcess.pid
    console.error(`[terminal-ime] started window manager PID ${windowManagerProcess.pid}`)

    if (nestedWayland) {
      // GNOME starts IBus in the private session; a second daemon can compete for ownership.
      await waitForHangulEngine(windowManagerProcess)
    } else {
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
      await waitForHangulEngine(ibusProcess)
    }
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
    evidence.ibusGroupBeforeCleanup = ibusProcess?.pid ? processGroupMembers(ibusProcess.pid) : []
    console.error(`[terminal-ime] owned IBus group: ${evidence.ibusGroupBeforeCleanup.join('; ')}`)

    const testProcess = spawn(
      process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
      nestedWayland
        ? [
            'exec',
            'playwright',
            'test',
            '--config',
            'tests/playwright.config.ts',
            'tests/e2e/terminal-hangul-terminating-digit-native.spec.ts',
            '--project=electron-headful',
            '--workers=1',
            '--repeat-each=3',
            '--retries=0',
            '--reporter=list,json'
          ]
        : [
            'run',
            'test:e2e:headful',
            '--workers=1',
            '--',
            'tests/e2e/terminal-ibus-hangul-native.spec.ts',
            'tests/e2e/terminal-hangul-terminating-digit-native.spec.ts'
          ],
      {
        cwd: projectDir,
        env: {
          ...process.env,
          ...(nestedWayland
            ? {
                ORCA_E2E_IME_INJECTOR: 'nested',
                ORCA_E2E_NESTED_FOCUS_CMD: path.join(
                  projectDir,
                  'config/scripts/focus-nested-wayland-terminal.sh'
                ),
                ORCA_E2E_EXTRA_APP_ARGS:
                  '--ozone-platform=wayland --enable-wayland-ime --wayland-text-input-version=3 --password-store=basic --use-mock-keychain --disable-gpu-sandbox',
                PLAYWRIGHT_JSON_OUTPUT_FILE: path.join(evidenceDir, 'playwright.json')
              }
            : {}),
          ORCA_E2E_FORWARD_APP_LOGS: '1',
          ORCA_E2E_NATIVE_IBUS_HANGUL: '1',
          [IME_ENGAGEMENT_RECEIPT_ENV]: receiptPath,
          // Why: native IBus key injection only reaches a window the window manager
          // has focused, so this run opts out of the background-launch policy.
          ORCA_E2E_FOREGROUND: '1'
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
    if (nestedWayland && existsSync(path.join(evidenceDir, 'playwright.json'))) {
      mkdirSync(path.join(projectDir, 'test-results'), { recursive: true })
      copyFileSync(
        path.join(evidenceDir, 'playwright.json'),
        path.join(projectDir, 'test-results', 'terminal-wayland-playwright.json')
      )
    }
    closeSync(ibusLogFd)
    closeSync(windowManagerLogFd)
    mkdirSync(path.join(projectDir, 'test-results'), { recursive: true })
    copyFileSync(
      ibusLogPath,
      path.join(projectDir, 'test-results', 'terminal-ibus-hangul-native-ibus.log')
    )
    copyFileSync(
      windowManagerLogPath,
      path.join(
        projectDir,
        'test-results',
        nestedWayland ? 'terminal-wayland-gnome-shell.log' : 'terminal-ibus-hangul-native-xfwm4.log'
      )
    )
    writeFileSync(
      path.join(projectDir, 'test-results', 'terminal-ibus-hangul-native-processes.json'),
      `${JSON.stringify(evidence, null, 2)}\n`
    )
    if (existsSync(receiptPath)) {
      copyFileSync(
        receiptPath,
        path.join(projectDir, 'test-results', 'terminal-ibus-hangul-native-engagement.jsonl')
      )
    }
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

  // Why unconditionally, and not only when Playwright failed: a skipped test reports as a pass,
  // so exit code 0 is exactly the state this check exists to distrust.
  const receiptText = existsSync(receiptPath) ? readFileSync(receiptPath, 'utf8') : ''
  if (nestedWayland) {
    verifyPlaywrightParticipation(
      JSON.parse(readFileSync(path.join(evidenceDir, 'playwright.json'), 'utf8')),
      { titles: [waylandTitle], label: 'Native Wayland Hangul', repetitions: 3 }
    )
    const receipts = receiptText.trim().split('\n')
    if (receipts.length !== 3) {
      throw new Error('Expected three native Wayland engagement receipts')
    }
    for (const receipt of receipts) {
      const problems = verifyImeEngagementReceipts(receipt, [waylandTitle])
      if (problems.length) {
        throw new Error(problems.join('\n'))
      }
    }
    return testExitCode
  }
  const engagementProblems = verifyImeEngagementReceipts(receiptText, EXPECTED_NATIVE_IME_TESTS)
  if (engagementProblems.length > 0) {
    for (const problem of engagementProblems) {
      console.error(`::error title=Native IME never engaged::${problem}`)
    }
    console.error(
      '[terminal-ime] the run produced no proof an input method engaged; treating it as a failure' +
        ` even though Playwright exited ${testExitCode}`
    )
    return 1
  }
  console.error(
    `[terminal-ime] engagement receipts verified for ${EXPECTED_NATIVE_IME_TESTS.length} tests`
  )
  return testExitCode
}

async function runOuter() {
  if (process.platform !== 'linux') {
    throw new Error('The native IBus Hangul E2E runner requires Linux')
  }

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
      ...(nestedWayland ? ['--server-args=-screen 0 1280x800x24'] : []),
      'dbus-run-session',
      '--',
      process.execPath,
      scriptPath,
      insideSessionFlag,
      evidenceDir,
      ...(nestedWayland ? [nestedWaylandFlag] : [])
    ],
    {
      cwd: projectDir,
      detached: true,
      env: {
        ...process.env,
        ...(nestedWayland
          ? {
              WAYLAND_DISPLAY: 'wayland-orca-ime',
              XDG_SESSION_TYPE: 'wayland',
              XDG_CURRENT_DESKTOP: 'GNOME',
              LIBGL_ALWAYS_SOFTWARE: '1',
              NO_AT_BRIDGE: '1'
            }
          : {}),
        GTK_IM_MODULE: 'ibus',
        IBUS_ENABLE_SYNC_MODE: '1',
        LANG: process.env.LANG || 'C.UTF-8',
        QT_IM_MODULE: 'ibus',
        // GNOME 42 drops XDG_CONFIG_HOME when spawning IBus; both must use its default path.
        XDG_CACHE_HOME: nestedWayland ? undefined : path.join(evidenceDir, 'cache'),
        XDG_CONFIG_HOME: nestedWayland ? undefined : path.join(evidenceDir, 'config'),
        XDG_RUNTIME_DIR: runtimeDir,
        XMODIFIERS: '@im=ibus'
      },
      stdio: 'inherit'
    }
  )
  if (!sessionProcess.pid) {
    throw new Error('xvfb-run did not return a PID')
  }
  console.error(`[terminal-ime] started isolated display session PID ${sessionProcess.pid}`)
  const exitCode = await waitForExit(sessionProcess)
  const remaining = await stopOwnedProcessGroup(sessionProcess.pid)
  if (remaining.length > 0) {
    throw new Error(`Owned display session processes survived cleanup: ${remaining.join('; ')}`)
  }
  return exitCode
}

const insideSession = process.argv[2] === insideSessionFlag
try {
  if (nestedWayland && process.env.GITHUB_ACTIONS !== 'true') {
    throw new Error('Nested Wayland native input validation runs only in GitHub Actions')
  }
  if (insideSession && !process.argv[3]) {
    throw new Error(`${insideSessionFlag} requires an evidence directory argument`)
  }
  process.exitCode = insideSession ? await runInsideSession(process.argv[3]) : await runOuter()
} catch (error) {
  console.error(`[terminal-ime] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
