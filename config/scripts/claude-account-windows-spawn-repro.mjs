import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildWindowsCommandInvocation } from '../../src/main/claude-accounts/windows-command-invocation.ts'

const strategy = process.argv[2]
if (!['baseline', 'candidate', 'explicit-cmd'].includes(strategy)) {
  throw new Error(
    'Usage: node config/scripts/claude-account-windows-spawn-repro.mjs <baseline|candidate|explicit-cmd>'
  )
}
if (process.platform !== 'win32') {
  throw new Error('This reproduction requires a physical Windows host.')
}

const expectedArgs = [
  '',
  'two words',
  'amp&ersand',
  'pipe|value',
  'less<value',
  'greater>value',
  'caret^value',
  'trailing\\',
  'two-trailing\\\\',
  '(parentheses)',
  '100%',
  '%ORCA_ARG_TRAP%',
  'bang!value',
  '한글-λ'
]
const tempRoot = await mkdtemp(join(tmpdir(), 'orca-claude-spawn-'))
const reportedDir = join(tempRoot, 'Profile with spaces 한글')
const reportedCapturePath = join(reportedDir, 'capture.json')
const reportedPidPath = join(reportedDir, 'pids.json')
const reportedShimPath = join(reportedDir, 'claude fixture.cmd')
const reportedFixturePath = join(reportedDir, 'capture-child.cjs')
const fixtureDir = join(tempRoot, 'Profile space & ^ (paren) %ORCA_PATH_TRAP% !bang! 한글')
const capturePath = join(fixtureDir, 'capture.json')
const pidPath = join(fixtureDir, 'pids.json')
const shimPath = join(fixtureDir, 'claude fixture.cmd')
const fixturePath = join(fixtureDir, 'capture-child.cjs')
const fixtureEnv = {
  ...process.env,
  CLAUDE_CONFIG_DIR: join(fixtureDir, 'config space & ^ (paren) %ORCA_ENV_LITERAL% !bang! 한글'),
  ORCA_ARG_TRAP: 'EXPANDED_ARG',
  ORCA_PATH_TRAP: 'EXPANDED_PATH',
  ORCA_FIXTURE_CAPTURE: capturePath,
  ORCA_FIXTURE_PIDS: pidPath,
  ORCA_FIXTURE_NODE: process.execPath
}
const reportedEnv = {
  ...fixtureEnv,
  CLAUDE_CONFIG_DIR: join(reportedDir, 'config with spaces 한글'),
  ORCA_FIXTURE_CAPTURE: reportedCapturePath,
  ORCA_FIXTURE_PIDS: reportedPidPath
}

function quoteForCandidate(value) {
  return `"${value.replace(/"/g, '""')}"`
}

function launch(args, command = shimPath, env = fixtureEnv) {
  if (strategy === 'baseline') {
    return spawn(command, args, { cwd: tempRoot, env, shell: true, windowsHide: true })
  }
  if (strategy === 'candidate') {
    return spawn(quoteForCandidate(command), args, {
      cwd: tempRoot,
      env,
      shell: true,
      windowsHide: true
    })
  }
  const invocation = buildWindowsCommandInvocation(command, args)
  return spawn(invocation.command, invocation.args, {
    cwd: tempRoot,
    env,
    shell: false,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    windowsHide: true
  })
}

function collect(child) {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => (stdout += chunk.toString()))
    child.stderr?.on('data', (chunk) => (stderr += chunk.toString()))
    child.on('error', (error) => resolve({ code: null, stdout, stderr, error: error.message }))
    child.on('close', (code) => resolve({ code, stdout, stderr, error: null }))
  })
}

async function waitForFile(path, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(path, 'utf8'))
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  throw new Error(`Timed out waiting for fixture output: ${path}`)
}

async function taskExists(pid) {
  const result = await collect(
    spawn('tasklist.exe', ['/fi', `PID eq ${pid}`, '/fo', 'csv', '/nh'], {
      windowsHide: true
    })
  )
  if (result.error || result.code !== 0) {
    throw new Error(`tasklist failed for PID ${pid}: ${result.error ?? result.stderr}`)
  }
  return result.stdout.includes(`"${pid}"`)
}

async function killTree(pid) {
  const result = await collect(
    spawn('taskkill.exe', ['/pid', String(pid), '/t', '/f'], { windowsHide: true })
  )
  if (result.error || result.code !== 0) {
    throw new Error(`taskkill failed for PID ${pid}: ${result.error ?? result.stderr}`)
  }
}

async function waitForTreeExit(pids, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  let alive = {}
  do {
    alive = Object.fromEntries(
      await Promise.all(
        Object.entries(pids).map(async ([name, pid]) => [name, await taskExists(pid)])
      )
    )
    if (!Object.values(alive).some(Boolean)) {
      return alive
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  } while (Date.now() < deadline)
  return alive
}

const results = {
  strategy,
  reportedPath: null,
  pathMatrix: {},
  argvMatrix: {},
  hostilePathAndArgv: null,
  error: null,
  cancellation: null
}
const fixtureSource =
  `const { spawn } = require('node:child_process')\n` +
  `const { writeFileSync } = require('node:fs')\n` +
  `if (process.argv[2] === '--exit-error') { process.stderr.write('fixture error: 한글 & ^ % !\\n'); process.exit(23) }\n` +
  `if (process.argv[2] === '--linger') {\n` +
  `  const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true })\n` +
  `  writeFileSync(process.env.ORCA_FIXTURE_PIDS, JSON.stringify({ child: process.pid, grandchild: grandchild.pid }))\n` +
  `  setInterval(() => {}, 1000)\n` +
  `} else {\n` +
  `  writeFileSync(process.env.ORCA_FIXTURE_CAPTURE, JSON.stringify({ argv: process.argv.slice(2), configDir: process.env.CLAUDE_CONFIG_DIR }))\n` +
  `}\n`
const shimSource = '@echo off\r\n"%ORCA_FIXTURE_NODE%" "%~dp0capture-child.cjs" %*\r\n'
let lingeringShellPid = null
try {
  await mkdir(fixtureDir, { recursive: true })
  await mkdir(reportedDir, { recursive: true })
  await writeFile(fixturePath, fixtureSource, 'utf8')
  await writeFile(shimPath, shimSource, 'utf8')
  await writeFile(reportedFixturePath, fixtureSource, 'utf8')
  await writeFile(reportedShimPath, shimSource, 'utf8')

  const reportedArgs = ['auth', 'status', '--json']
  const reportedRun = await collect(launch(reportedArgs, reportedShimPath, reportedEnv))
  let reportedCapture = null
  try {
    reportedCapture = await waitForFile(reportedCapturePath, 1_000)
  } catch {}
  results.reportedPath = {
    ...reportedRun,
    actual: reportedCapture,
    expected: { argv: reportedArgs, configDir: reportedEnv.CLAUDE_CONFIG_DIR },
    pass:
      reportedRun.code === 0 &&
      JSON.stringify(reportedCapture) ===
        JSON.stringify({ argv: reportedArgs, configDir: reportedEnv.CLAUDE_CONFIG_DIR })
  }

  for (const [name, segment] of Object.entries({
    spaces: 'profile space',
    ampersand: 'profile&name',
    caret: 'profile^name',
    parentheses: 'profile(name)',
    percent: 'profile%ORCA_PATH_TRAP%',
    bang: 'profile!name',
    unicode: 'profile-한글-λ'
  })) {
    const directory = join(tempRoot, segment)
    const captureFile = join(directory, 'capture.json')
    const command = join(directory, 'claude fixture.cmd')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'capture-child.cjs'), fixtureSource, 'utf8')
    await writeFile(command, shimSource, 'utf8')
    const env = {
      ...fixtureEnv,
      CLAUDE_CONFIG_DIR: join(directory, 'config'),
      ORCA_FIXTURE_CAPTURE: captureFile
    }
    const run = await collect(launch(reportedArgs, command, env))
    let actual = null
    try {
      actual = await waitForFile(captureFile, 500)
    } catch {}
    results.pathMatrix[name] = {
      code: run.code,
      stderr: run.stderr.trim(),
      actual: actual?.argv ?? null,
      pass: run.code === 0 && JSON.stringify(actual?.argv) === JSON.stringify(reportedArgs)
    }
  }

  for (const [name, value] of Object.entries({
    empty: '',
    spaces: 'two words',
    ampersand: 'amp&ersand',
    pipe: 'pipe|value',
    lessThan: 'less<value',
    greaterThan: 'greater>value',
    caret: 'caret^value',
    trailingBackslash: 'trailing\\',
    twoTrailingBackslashes: 'two-trailing\\\\',
    parentheses: '(parentheses)',
    percent: '%ORCA_ARG_TRAP%',
    bang: 'bang!value',
    unicode: '한글-λ'
  })) {
    const args = ['prefix', value, 'suffix']
    const captureFile = join(reportedDir, `capture-${name}.json`)
    const env = { ...reportedEnv, ORCA_FIXTURE_CAPTURE: captureFile }
    const run = await collect(launch(args, reportedShimPath, env))
    let actual = null
    try {
      actual = await waitForFile(captureFile, 500)
    } catch {}
    results.argvMatrix[name] = {
      code: run.code,
      stderr: run.stderr.trim(),
      actual: actual?.argv ?? null,
      pass: run.code === 0 && JSON.stringify(actual?.argv) === JSON.stringify(args)
    }
  }

  const argvRun = await collect(launch(expectedArgs))
  let capture = null
  try {
    capture = await waitForFile(capturePath, 1_000)
  } catch {}
  results.hostilePathAndArgv = {
    ...argvRun,
    actual: capture,
    expected: { argv: expectedArgs, configDir: fixtureEnv.CLAUDE_CONFIG_DIR },
    pass:
      argvRun.code === 0 &&
      JSON.stringify(capture) ===
        JSON.stringify({ argv: expectedArgs, configDir: fixtureEnv.CLAUDE_CONFIG_DIR })
  }

  results.error = await collect(launch(['--exit-error'], reportedShimPath, reportedEnv))
  results.error.pass =
    results.error.code === 23 && results.error.stderr.includes('fixture error: 한글 & ^ % !')

  const lingering = launch(['--linger'], reportedShimPath, reportedEnv)
  lingeringShellPid = lingering.pid
  const lingeringResult = collect(lingering)
  try {
    const pids = await waitForFile(reportedPidPath)
    await killTree(lingering.pid)
    const alive = await waitForTreeExit({
      shell: lingering.pid,
      child: pids.child,
      grandchild: pids.grandchild
    })
    results.cancellation = {
      shell: lingering.pid,
      ...pids,
      alive,
      pass: !Object.values(alive).some(Boolean)
    }
  } catch (error) {
    if (await taskExists(lingering.pid)) {
      await killTree(lingering.pid)
    }
    const launchResult = await Promise.race([
      lingeringResult,
      new Promise((resolve) =>
        setTimeout(
          () => resolve({ code: null, error: 'fixture did not exit after cleanup' }),
          5_000
        )
      )
    ])
    results.cancellation = {
      shell: lingering.pid,
      launchResult,
      pass: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
} finally {
  if (lingeringShellPid && (await taskExists(lingeringShellPid))) {
    await killTree(lingeringShellPid)
  }
  try {
    let pids
    try {
      pids = JSON.parse(await readFile(reportedPidPath, 'utf8'))
    } catch {
      pids = JSON.parse(await readFile(pidPath, 'utf8'))
    }
    for (const pid of [pids.child, pids.grandchild]) {
      if (await taskExists(pid)) {
        await killTree(pid)
      }
    }
  } catch {}
  await rm(tempRoot, { recursive: true, force: true })
}

console.log(JSON.stringify(results, null, 2))
process.exitCode =
  results.reportedPath?.pass &&
  Object.values(results.pathMatrix).every((result) => result.pass) &&
  Object.values(results.argvMatrix).every((result) => result.pass) &&
  results.hostilePathAndArgv?.pass &&
  results.error?.pass &&
  results.cancellation?.pass
    ? 0
    : 1
