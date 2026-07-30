#!/usr/bin/env node
import { _electron as electron } from '@stablyai/playwright-test'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import readline from 'node:readline/promises'
import { pathToFileURL } from 'node:url'
import {
  classifyCodexHomeTripwireEvent,
  startCodexPrimaryHomeTripwire
} from './codex-primary-home-tripwire.mjs'
import {
  cleanupValidationDaemons,
  closeValidationElectronApp
} from './codex-validation-process-shutdown.mjs'

const RESTRICTED_ENV_KEYS = [
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'CODEX_HOME',
  'ORCA_CODEX_HOME',
  'ORCA_CODEX_SYSTEM_DEFAULT_REAL_HOME',
  'ORCA_E2E_HOME_DIR',
  'ORCA_E2E_USER_DATA_DIR',
  'ORCA_USER_DATA_PATH',
  'ZDOTDIR',
  'ORCA_ORIG_ZDOTDIR',
  'BASH_ENV',
  'ENV',
  'ELECTRON_RUN_AS_NODE'
]
const VALID_SCENARIOS = new Set(['mixed', 'managed-only', 'codex-lb'])

function samePath(left, right) {
  const normalizedLeft = path.resolve(left)
  const normalizedRight = path.resolve(right)
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight
}

function isWithin(candidate, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

async function resolveRealPath(candidate) {
  try {
    return await realpath(candidate)
  } catch {
    // Why: containment guards must still run for paths that do not exist yet.
    return candidate
  }
}

export function createValidationEnv(inheritedEnv, layout, options = {}) {
  const env = { ...inheritedEnv }
  for (const key of RESTRICTED_ENV_KEYS) {
    delete env[key]
  }
  return {
    ...env,
    HOME: layout.homeDir,
    USERPROFILE: layout.homeDir,
    NODE_ENV: 'development',
    ORCA_E2E_HOME_DIR: layout.homeDir,
    ORCA_E2E_USER_DATA_DIR: layout.userDataDir,
    ORCA_USER_DATA_PATH: layout.userDataDir,
    // Why: flag OFF pins every codex spawn to an explicit managed CODEX_HOME,
    // so native codex never resolves the OS profile — the only Windows
    // configuration where strict zero-event containment is reachable. It also
    // exercises the emergency kill-switch lane users fall back to.
    ORCA_CODEX_SYSTEM_DEFAULT_REAL_HOME: options.systemDefaultRealHome === 'off' ? '0' : '1'
  }
}

export async function createValidationLayout(options = {}) {
  const primaryHome = path.resolve(options.primaryHome ?? os.homedir())
  const envTempParent = process.env.ORCA_CODEX_VALIDATION_TEMP_PARENT?.trim()
  const tempParent = path.resolve(options.tempParent ?? (envTempParent || os.tmpdir()))
  // Why: guards must compare canonical paths — a symlinked temp parent must
  // not smuggle the disposable root inside the primary home.
  const [primaryHomeReal, tempParentReal] = await Promise.all([
    resolveRealPath(primaryHome),
    resolveRealPath(tempParent)
  ])
  // Why: on Windows the default %TEMP% lives inside %USERPROFILE%, which the
  // disposable-home guard below rightly refuses. Fail before creating anything
  // and point at the overrides instead of aborting with an opaque guard error.
  if (samePath(tempParentReal, primaryHomeReal) || isWithin(tempParentReal, primaryHomeReal)) {
    throw new Error(
      `Refusing to place the disposable validation root inside the primary home (${primaryHome}). ` +
        'Pass --temp-parent <dir> or set ORCA_CODEX_VALIDATION_TEMP_PARENT to a directory outside it.'
    )
  }
  const tempRoot = await mkdtemp(path.join(tempParent, 'orca-codex-real-'))
  const homeDir = path.join(tempRoot, 'home')
  const userDataDir = path.join(tempRoot, 'user-data')
  await Promise.all([
    mkdir(homeDir, { recursive: true, mode: 0o700 }),
    mkdir(userDataDir, { recursive: true, mode: 0o700 })
  ])
  const homeDirReal = await resolveRealPath(homeDir)
  if (samePath(primaryHomeReal, homeDirReal) || isWithin(homeDirReal, primaryHomeReal)) {
    throw new Error('Refusing to place the disposable validation home inside the primary home')
  }
  return { primaryHome, tempRoot, homeDir, userDataDir }
}

async function seedCompletedProfile(layout) {
  // Why: the validation is about account routing, so first-run education and
  // telemetry overlays must not obscure the account controls under test.
  const profile = {
    settings: {
      telemetry: {
        optedIn: true,
        installId: '00000000-0000-4000-8000-000000000000',
        existedBeforeTelemetryRelease: false
      }
    },
    onboarding: { flowVersion: 2, closedAt: 1, outcome: 'completed', lastCompletedStep: 3 },
    ui: { contextualToursAutoEligible: false, projectOrderManualDefaultNoticeDismissed: true }
  }
  await writeFile(
    path.join(layout.userDataDir, 'orca-data.json'),
    `${JSON.stringify(profile, null, 2)}\n`
  )
}

async function installCodexConfigTemplate(layout, templatePath) {
  if (!templatePath) {
    return
  }
  const resolvedTemplate = await realpath(path.resolve(templatePath))
  const primaryCodexHome = path.join(layout.primaryHome, '.codex')
  // Why: validation must never bootstrap itself from the user's live Codex
  // configuration, even when a caller passes that path accidentally.
  if (isWithin(resolvedTemplate, primaryCodexHome)) {
    throw new Error('Refusing to copy a config template from the primary ~/.codex')
  }
  await mkdir(path.join(layout.homeDir, '.codex'), { recursive: true, mode: 0o700 })
  await copyFile(resolvedTemplate, path.join(layout.homeDir, '.codex', 'config.toml'))
}

async function fingerprintFile(filePath) {
  try {
    const stat = await lstat(filePath)
    if (!stat.isFile()) {
      return { exists: true, type: stat.isSymbolicLink() ? 'symlink' : 'other' }
    }
    const contents = await readFile(filePath)
    return {
      exists: true,
      type: 'file',
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      sha256: createHash('sha256').update(contents).digest('hex')
    }
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { exists: false }
    }
    throw error
  }
}

async function inventoryTree(rootPath) {
  const entries = []
  async function visit(absolutePath, relativePath) {
    const stat = await lstat(absolutePath)
    const type = stat.isDirectory()
      ? 'directory'
      : stat.isFile()
        ? 'file'
        : stat.isSymbolicLink()
          ? 'symlink'
          : 'other'
    entries.push({ path: relativePath || '.', type, size: stat.size, mtimeMs: stat.mtimeMs })
    if (type !== 'directory') {
      return
    }
    const children = await readdir(absolutePath)
    children.sort((left, right) => left.localeCompare(right))
    for (const child of children) {
      await visit(
        path.join(absolutePath, child),
        relativePath ? path.join(relativePath, child) : child
      )
    }
  }
  try {
    await visit(rootPath, '')
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return []
    }
    throw error
  }
  return entries
}

async function snapshotManagedHomes(userDataDir) {
  const accountsRoot = path.join(userDataDir, 'codex-accounts')
  let accountNames = []
  try {
    accountNames = (await readdir(accountsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right))
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error
    }
  }
  return Promise.all(
    accountNames.map(async (accountId) => {
      const homePath = path.join(accountsRoot, accountId, 'home')
      return {
        accountId,
        homePath,
        inventory: await inventoryTree(homePath),
        auth: await fingerprintFile(path.join(homePath, 'auth.json'))
      }
    })
  )
}

export async function snapshotValidationState(layout) {
  const throwawayCodexHome = path.join(layout.homeDir, '.codex')
  return {
    capturedAt: new Date().toISOString(),
    throwawayCodex: {
      auth: await fingerprintFile(path.join(throwawayCodexHome, 'auth.json')),
      config: await fingerprintFile(path.join(throwawayCodexHome, 'config.toml')),
      hooks: await fingerprintFile(path.join(throwawayCodexHome, 'hooks.json'))
    },
    managedHomes: await snapshotManagedHomes(layout.userDataDir),
    sharedRuntimeAuth: await fingerprintFile(
      path.join(layout.userDataDir, 'codex-runtime-home', 'home', 'auth.json')
    )
  }
}

function parseArgs(argv) {
  const options = {
    scenario: 'mixed',
    dryRun: false,
    closeAfterLaunch: false,
    skipBuild: false,
    keep: false,
    reportPath: null,
    primaryHome: os.homedir(),
    configTemplate: null,
    tempParent: null,
    laneAwareContainment: false,
    systemDefaultRealHome: 'on'
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const readValue = () => {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) {
        throw new Error(`Missing value for ${arg}`)
      }
      index += 1
      return value
    }
    if (arg === '--scenario') {
      options.scenario = readValue()
    } else if (arg === '--report') {
      options.reportPath = path.resolve(readValue())
    } else if (arg === '--primary-home') {
      options.primaryHome = path.resolve(readValue())
    } else if (arg === '--config-template') {
      options.configTemplate = path.resolve(readValue())
    } else if (arg === '--temp-parent') {
      options.tempParent = path.resolve(readValue())
    } else if (arg === '--dry-run') {
      options.dryRun = true
    } else if (arg === '--close-after-launch') {
      options.closeAfterLaunch = true
    } else if (arg === '--skip-build') {
      options.skipBuild = true
    } else if (arg === '--keep') {
      options.keep = true
    } else if (arg === '--system-default-real-home') {
      const value = readValue()
      if (value !== 'on' && value !== 'off') {
        throw new Error('--system-default-real-home must be "on" or "off"')
      }
      options.systemDefaultRealHome = value
    } else if (arg === '--lane-aware-containment') {
      // Why: on Windows the flag-ON system-default lane cannot be env-sandboxed
      // (native codex ignores USERPROFILE), so strict zero-event containment is
      // structurally unreachable there. This mode records codex's designed
      // volatile churn without aborting while every other real-home write stays
      // a hard failure. The absolute zero-event claim is carried by macOS runs.
      options.laneAwareContainment = true
    } else if (arg === '--help') {
      console.log(
        'Usage: node config/scripts/run-codex-real-account-validation.mjs [--scenario mixed|managed-only|codex-lb] [--config-template <path>] [--temp-parent <dir>] [--skip-build] [--dry-run] [--close-after-launch] [--keep] [--lane-aware-containment] [--system-default-real-home on|off] [--report <path>]'
      )
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  if (!VALID_SCENARIOS.has(options.scenario)) {
    throw new Error(`Invalid scenario: ${options.scenario}`)
  }
  if (options.scenario === 'codex-lb' && !options.configTemplate) {
    throw new Error('The codex-lb scenario requires --config-template outside primary ~/.codex')
  }
  return options
}

// Why: `npx` resolves to a .cmd shim on Windows that execFileSync cannot launch
// (ENOENT), so the harness could not build its own app there. Run the
// repository-local electron-vite JS entry with the current Node binary instead;
// process.execPath + a resolved .js path behaves identically on macOS, Linux,
// and Windows without a shell.
export function resolveElectronViteBuildCommand(repoRoot) {
  const electronViteEntry = path.join(
    repoRoot,
    'node_modules',
    'electron-vite',
    'bin',
    'electron-vite.js'
  )
  if (!existsSync(electronViteEntry)) {
    throw new Error(
      `Cannot build the validation app: electron-vite entry not found at ${electronViteEntry}. ` +
        'Install dependencies (pnpm install) or pass --skip-build with a prebuilt out/main/index.js.'
    )
  }
  return { command: process.execPath, args: [electronViteEntry, 'build', '--mode', 'e2e'] }
}

function buildAppIfNeeded(repoRoot, skipBuild) {
  const mainPath = path.join(repoRoot, 'out', 'main', 'index.js')
  if (skipBuild) {
    if (!existsSync(mainPath)) {
      throw new Error(`--skip-build requested, but ${mainPath} does not exist`)
    }
    return mainPath
  }
  const { command, args } = resolveElectronViteBuildCommand(repoRoot)
  execFileSync(command, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env, VITE_EXPOSE_STORE: 'true' }
  })
  return mainPath
}

function validationCliCommand() {
  if (process.env.ORCA_VALIDATION_CLI) {
    return process.env.ORCA_VALIDATION_CLI
  }
  if (process.env.ORCA_CLI_COMMAND) {
    return process.env.ORCA_CLI_COMMAND
  }
  return process.platform === 'linux' ? 'orca-ide' : 'orca'
}

async function probeTerminalEnvironment(terminalHandle, launchEnv) {
  const marker = `__ORCA_CODEX_VALIDATION_${randomUUID()}__`
  const command = [
    'node -e',
    `"console.log('${marker}:' + JSON.stringify({home: require('node:os').homedir(), codexHome: process.env.CODEX_HOME || null, orcaCodexHome: process.env.ORCA_CODEX_HOME || null}))"`
  ].join(' ')
  const cli = validationCliCommand()
  execFileSync(
    cli,
    ['terminal', 'send', '--terminal', terminalHandle, '--text', command, '--enter', '--json'],
    { env: launchEnv, stdio: 'pipe' }
  )
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const output = execFileSync(cli, ['terminal', 'read', '--terminal', terminalHandle, '--json'], {
      env: launchEnv,
      encoding: 'utf8'
    })
    const match = new RegExp(`${marker}:(\\{[^\\r\\n]+\\})`).exec(output)
    if (match?.[1]) {
      return JSON.parse(match[1])
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Timed out waiting for environment probe in terminal ${terminalHandle}`)
}

async function writeReport(reportPath, report) {
  await mkdir(path.dirname(reportPath), { recursive: true })
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
}

async function runInteractiveSession(context) {
  if (process.stdin.readableEnded) {
    return
  }
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout })
  const closePrompt = () => prompt.close()
  // Why: redirected stdin can close before `question()` consumes a command.
  // Race the prompt so EOF still unwinds through app and credential cleanup.
  const inputClosed = new Promise((resolve) => prompt.once('close', () => resolve(null)))
  context.signal.addEventListener('abort', closePrompt, { once: true })
  console.log('Commands: checkpoint <label>, probe <terminal-handle>, status, done')
  try {
    while (!context.signal.aborted) {
      const answer = await Promise.race([prompt.question('codex-validation> '), inputClosed])
      if (answer === null) {
        return
      }
      const line = answer.trim()
      const [command, ...rest] = line.split(/\s+/)
      if (command === 'checkpoint') {
        const label = rest.join(' ') || `checkpoint-${context.report.checkpoints.length + 1}`
        context.report.checkpoints.push({
          label,
          ...(await snapshotValidationState(context.layout)),
          primaryTripwire: context.tripwire.getStatus()
        })
        await writeReport(context.reportPath, context.report)
        console.log(`Recorded ${label}`)
      } else if (command === 'probe') {
        const terminalHandle = rest[0]
        if (!terminalHandle) {
          console.log('Usage: probe <terminal-handle>')
          continue
        }
        const environment = await probeTerminalEnvironment(terminalHandle, context.launchEnv)
        context.report.terminalProbes.push({
          capturedAt: new Date().toISOString(),
          terminalHandle,
          environment
        })
        await writeReport(context.reportPath, context.report)
        console.log(JSON.stringify(environment, null, 2))
      } else if (command === 'status') {
        console.log(JSON.stringify(context.tripwire.getStatus(), null, 2))
      } else if (command === 'done') {
        return
      } else if (command) {
        console.log('Commands: checkpoint <label>, probe <terminal-handle>, status, done')
      }
    }
  } catch (error) {
    if (!context.signal.aborted) {
      throw error
    }
  } finally {
    context.signal.removeEventListener('abort', closePrompt)
    prompt.close()
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const repoRoot = process.cwd()
  const layout = await createValidationLayout({
    primaryHome: options.primaryHome,
    tempParent: options.tempParent ?? undefined
  })
  const reportPath =
    options.reportPath ??
    path.join(os.tmpdir(), `orca-codex-real-account-${options.scenario}-${Date.now()}.json`)
  const launchEnv = createValidationEnv(process.env, layout, options)
  let app = null
  let tripwire = null
  const abortController = new AbortController()
  const abortForSignal = () => abortController.abort()
  process.once('SIGINT', abortForSignal)
  process.once('SIGTERM', abortForSignal)
  const report = {
    scenario: options.scenario,
    startedAt: new Date().toISOString(),
    reportVersion: 1,
    disposableHome: layout.homeDir,
    userDataDir: layout.userDataDir,
    primaryCodexHome: path.join(layout.primaryHome, '.codex'),
    electronPaths: null,
    checkpoints: [],
    terminalProbes: [],
    tripwire: null
  }

  try {
    await seedCompletedProfile(layout)
    await installCodexConfigTemplate(layout, options.configTemplate)
    tripwire = await startCodexPrimaryHomeTripwire({
      primaryHome: layout.primaryHome,
      onChange: (event) => {
        if (
          options.laneAwareContainment &&
          classifyCodexHomeTripwireEvent(event) === 'designed-system-default'
        ) {
          console.warn(
            '[LANE-DESIGNED] Real ~/.codex volatile churn from the system-default codex lane (recorded, not a violation)'
          )
          console.warn(JSON.stringify(event, null, 2))
          return
        }
        console.error('\u001b[31;1m[VALIDATION ABORTED] Primary ~/.codex changed\u001b[0m')
        console.error(JSON.stringify(event, null, 2))
        abortController.abort()
      }
    })
    report.checkpoints.push({
      label: 'prepared',
      ...(await snapshotValidationState(layout)),
      primaryTripwire: tripwire.getStatus()
    })
    await writeReport(reportPath, report)
    console.log(`Disposable HOME: ${layout.homeDir}`)
    console.log(`Disposable userData: ${layout.userDataDir}`)
    console.log(`Sanitized report: ${reportPath}`)

    if (!options.dryRun) {
      const mainPath = buildAppIfNeeded(repoRoot, options.skipBuild)
      app = await electron.launch({ args: [mainPath], env: launchEnv })
      report.electronPaths = await app.evaluate(({ app: electronApp }) => ({
        home: electronApp.getPath('home'),
        userData: electronApp.getPath('userData'),
        nodeHome: process.getBuiltinModule('node:os').homedir()
      }))
      if (
        !samePath(report.electronPaths.home, layout.homeDir) ||
        !samePath(report.electronPaths.nodeHome, layout.homeDir) ||
        !samePath(report.electronPaths.userData, layout.userDataDir)
      ) {
        throw new Error('Electron escaped the disposable validation boundary')
      }
      app.process().once('exit', () => abortController.abort())
      await writeReport(reportPath, report)
      if (!options.closeAfterLaunch) {
        await runInteractiveSession({
          layout,
          launchEnv,
          report,
          reportPath,
          tripwire,
          signal: abortController.signal
        })
      }
    }
  } finally {
    abortController.abort()
    try {
      await closeValidationElectronApp(app)
      await cleanupValidationDaemons(layout.userDataDir)
      if (tripwire) {
        const tripwireStatus = await tripwire.stop()
        report.tripwire = options.laneAwareContainment
          ? { ...tripwireStatus, laneAware: summarizeLaneAwareTripwire(tripwireStatus.events) }
          : tripwireStatus
      }
      report.checkpoints.push({ label: 'shutdown', ...(await snapshotValidationState(layout)) })
      report.completedAt = new Date().toISOString()
      await writeReport(reportPath, report)
    } finally {
      try {
        if (options.keep) {
          console.warn(`Credential-bearing disposable root kept at ${layout.tempRoot}`)
        } else {
          // Why: a detached codex descendant can briefly hold a Windows handle
          // in the disposable home; retry so cleanup never strands credentials.
          await rm(layout.tempRoot, {
            recursive: true,
            force: true,
            maxRetries: 10,
            retryDelay: 250
          })
          console.log('Removed the credential-bearing disposable root.')
        }
      } finally {
        process.removeListener('SIGINT', abortForSignal)
        process.removeListener('SIGTERM', abortForSignal)
      }
    }
  }

  const tripwireFailed = report.tripwire
    ? options.laneAwareContainment
      ? report.tripwire.laneAware.violations.length > 0
      : !report.tripwire.clean
    : false
  if (tripwireFailed) {
    process.exitCode = 2
  } else {
    if (options.laneAwareContainment && report.tripwire?.events.length) {
      console.warn(
        `Lane-aware containment: ${report.tripwire.laneAware.designedLaneEvents.length} designed system-default event(s) recorded, 0 violations. Review them in the report.`
      )
    }
    console.log(`Validation harness complete. Report: ${reportPath}`)
  }
}

function summarizeLaneAwareTripwire(events) {
  const designedLaneEvents = []
  const violations = []
  for (const event of events) {
    if (classifyCodexHomeTripwireEvent(event) === 'designed-system-default') {
      designedLaneEvents.push(event)
    } else {
      violations.push(event)
    }
  }
  return { designedLaneEvents, violations }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
