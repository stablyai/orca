#!/usr/bin/env node

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { rm } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { orcadBunRuntimeFilename } from '../../src/shared/orcad-artifacts.ts'
import {
  selectOrcadLifecycleRuntime,
  selectOrcadLifecycleArtifact
} from './orcad-bun-lifecycle-runtime-selection.mjs'
import { runProcessSync, spawnProcess } from './script-child-process.mjs'
import {
  hasOrcadLifecycleOutputLine,
  verifyOrcadLifecycleTerminalRoundTrip
} from './orcad-bun-lifecycle-terminal-probe.mjs'

const root = join(import.meta.dirname, '..', '..')

function argument(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? null : process.argv[index + 1]
}

const artifactDir = resolve(
  argument('--artifact-dir') ?? process.env.ORCAD_E2E_ARTIFACT_DIR ?? join(root, 'out', 'orcad')
)
const legacyArtifactArgument = argument('--legacy-artifact-dir')
if (process.argv.includes('--legacy-artifact-dir') && !legacyArtifactArgument) {
  throw new Error('--legacy-artifact-dir requires a directory')
}
const legacyArtifactDir = legacyArtifactArgument ? resolve(legacyArtifactArgument) : artifactDir
const cliEntry = process.env.ORCAD_E2E_CLI_ENTRY ?? join(root, 'out', 'cli', 'index.js')
const bundledBun = join(artifactDir, orcadBunRuntimeFilename(process.platform))
const bun = process.env.BUN_EXECUTABLE ?? (existsSync(bundledBun) ? bundledBun : 'bun')
const cliRuntime = process.env.ORCAD_E2E_CLI_RUNTIME ?? process.execPath
const hostNodeRuntime = process.env.ORCA_BUN_SCRIPT_HOST_NODE ?? process.execPath
const migrationMode = process.argv.includes('--node-bun-node')
const initialArtifactDir = selectOrcadLifecycleArtifact({
  migrationMode,
  bunArtifactDir: artifactDir,
  legacyArtifactDir
})
const port = 6900 + Math.floor(Math.random() * 100)
const dataRoot = realpathSync(mkdtempSync(join(tmpdir(), 'orcad-e2e-')))
const workspaceRoot = join(dataRoot, 'workspaces')
const repoRoot = mkdtempSync(join(tmpdir(), 'orca-bun-repo-'))
const logPath = join(dataRoot, 'orcad.log')
const stopRequestPaths = new WeakMap()
const daemonPids = []
let runtime = null
let worktreePath = null
let activePairing = null
let terminalHandle = null
let succeeded = false
const childEnv = { ...process.env, ORCA_USER_DATA: dataRoot, ORCA_BACKGROUND_LAUNCH: '1' }
writeFileSync(
  join(dataRoot, 'orca-data.json'),
  JSON.stringify({ settings: { workspaceDir: workspaceRoot, nestWorkspaces: false } })
)

function fail(message) {
  throw new Error(message)
}

function run(command, args, options = {}) {
  const result = runProcessSync({ program: command, args, env: childEnv, ...options })
  if (result.code !== 0) {
    fail(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
  }
  return result.stdout
}

function cli(pairingCode, args) {
  const raw = run(cliRuntime, [cliEntry, ...args, '--pairing-code', pairingCode, '--json'])
  const response = JSON.parse(raw)
  if (response.ok !== true) {
    fail(`CLI ${args.join(' ')} failed: ${raw}`)
  }
  return response.result ?? response
}

async function removeLifecycleFixtureDirectory(directory) {
  // Bun's Windows fs.rm does not reliably apply maxRetries after process teardown.
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rm(directory, { recursive: true, force: true })
      return
    } catch (error) {
      if (attempt >= 50 || !['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error.code)) {
        throw error
      }
      await delay(100)
    }
  }
}

async function waitForLifecycleDaemonExit(pid) {
  const deadline = Date.now() + 15_000
  while (true) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      if (error.code === 'ESRCH') {
        return
      }
      throw error
    }
    if (Date.now() >= deadline) {
      throw new Error(`Lifecycle daemon ${pid} did not exit during cleanup`)
    }
    await delay(50)
  }
}

function waitForExit(child, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve()
      return
    }
    const timer = setTimeout(
      () => reject(new Error('orcad did not exit after stop request')),
      timeoutMs
    )
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

async function stopRuntime(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return
  }
  if (process.platform === 'win32') {
    const stopRequestPath = stopRequestPaths.get(child)
    if (!stopRequestPath) {
      throw new Error('Lifecycle child has no recorded artifact stop path')
    }
    writeFileSync(stopRequestPath, '')
  } else {
    child.kill('SIGTERM')
  }
  await waitForExit(child)
}

function startRuntime(runtimeExecutable = bun, selectedArtifactDir = artifactDir) {
  const child = spawnProcess({
    program: runtimeExecutable,
    args: [join(selectedArtifactDir, 'orcad.js'), '--port', String(port), '--json'],
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  stopRequestPaths.set(child, join(selectedArtifactDir, '.orcad-stop-request'))
  let output = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    output += chunk
    writeFileSync(logPath, output)
  })
  child.stderr.on('data', (chunk) => {
    output += chunk
    writeFileSync(logPath, output)
  })
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Bun orcad readiness timeout')), 90_000)
    const rejectStartup = (error) => {
      clearTimeout(timer)
      child.stdout.off('data', onData)
      reject(error)
    }
    const onData = () => {
      const line = output
        .split('\n')
        .find((candidate) => candidate.startsWith('{"type":"orca_server_ready"'))
      if (!line) {
        return
      }
      clearTimeout(timer)
      child.stdout.off('data', onData)
      try {
        resolve(JSON.parse(line))
      } catch (error) {
        reject(error)
      }
    }
    child.stdout.on('data', onData)
    child.once('error', rejectStartup)
    child.once('exit', (code) =>
      rejectStartup(new Error(`Bun orcad exited before readiness: ${code}`))
    )
  })
  return { child, ready }
}

function readTerminal(pairingCode, handle) {
  return cli(pairingCode, ['terminal', 'read', '--terminal', handle])
}

async function waitForWritableTerminal(pairingCode, handle) {
  let terminal
  for (let attempt = 0; attempt < 30; attempt += 1) {
    terminal = cli(pairingCode, ['terminal', 'show', '--terminal', handle]).terminal
    if (terminal?.writable) {
      return
    }
    if (terminal?.exitCause) {
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  fail(`Lifecycle terminal never became writable: ${JSON.stringify(terminal)}`)
}

function probeTerminal(pairingCode, handle, marker) {
  return verifyOrcadLifecycleTerminalRoundTrip({
    marker,
    waitForWritable: () => waitForWritableTerminal(pairingCode, handle),
    send: (command) =>
      cli(pairingCode, ['terminal', 'send', '--terminal', handle, '--text', command, '--enter']),
    read: () => readTerminal(pairingCode, handle)
  })
}

try {
  run('git', ['init', '-q', repoRoot])
  run('git', ['-C', repoRoot, 'checkout', '-q', '-b', 'main'])
  writeFileSync(join(repoRoot, 'README.md'), '# Bun lifecycle\n')
  run('git', ['-C', repoRoot, 'add', '-A'])
  run('git', [
    '-C',
    repoRoot,
    '-c',
    'user.email=orca@test',
    '-c',
    'user.name=Orca',
    'commit',
    '-qm',
    'seed'
  ])

  runtime = startRuntime(
    selectOrcadLifecycleRuntime({
      migrationMode,
      bundledBun: bun,
      hostNodeRuntime
    }),
    initialArtifactDir
  )
  const firstReady = await runtime.ready
  const firstPairing = firstReady.pairing.url
  activePairing = firstPairing
  const firstHealth = firstReady.health
  const expectedFirstRuntime = migrationMode ? 'node' : 'bun'
  const expectedFirstBackend = migrationMode ? 'node-pty' : 'bun-terminal'
  if (
    firstHealth?.platform !== process.platform ||
    firstHealth?.arch !== process.arch ||
    firstHealth?.runtimeKind !== expectedFirstRuntime ||
    firstHealth?.ptyBackend !== expectedFirstBackend ||
    (expectedFirstRuntime === 'bun' && !firstHealth?.runtimeVersion)
  ) {
    fail(`unexpected first runtime health metadata: ${JSON.stringify(firstHealth)}`)
  }
  if (!firstHealth?.terminalDaemon?.pid) {
    fail(`Readiness omitted terminal daemon PID: ${JSON.stringify(firstHealth)}`)
  }
  if (
    firstHealth.terminalDaemon.runtimeKind !== expectedFirstRuntime ||
    firstHealth.terminalDaemon.ptyBackend !== expectedFirstBackend ||
    (expectedFirstRuntime === 'bun' && !firstHealth.terminalDaemon.runtimeVersion)
  ) {
    fail(
      `terminal daemon runtime does not match the orcad runtime: ${JSON.stringify(firstHealth.terminalDaemon)}`
    )
  }
  daemonPids.push(firstHealth.terminalDaemon.pid)

  const repo = cli(firstPairing, ['repo', 'add', '--path', repoRoot]).repo
  const created = cli(firstPairing, [
    'worktree',
    'create',
    '--repo',
    `id:${repo.id}`,
    '--name',
    `bun-e2e-${randomBytes(4).toString('hex')}`,
    '--setup',
    'skip'
  ]).worktree
  worktreePath = created.id.split('::')[1]
  const workspaceRelative = relative(workspaceRoot, worktreePath)
  if (!workspaceRelative || workspaceRelative.startsWith('..') || isAbsolute(workspaceRelative)) {
    worktreePath = null
    fail('Lifecycle worktree escaped the isolated workspace root')
  }
  const terminal = cli(firstPairing, ['terminal', 'create', '--worktree', created.id]).terminal
  terminalHandle = terminal.handle
  const marker = `ORCAD_BUN_LIFECYCLE_${randomBytes(8).toString('hex')}`
  await probeTerminal(firstPairing, terminalHandle, marker)

  await stopRuntime(runtime.child)
  if (process.kill(firstHealth.terminalDaemon.pid, 0) === false) {
    fail('Bun daemon did not survive orcad shutdown')
  }

  runtime = startRuntime(bun)
  const secondReady = await runtime.ready
  activePairing = secondReady.pairing.url
  const secondHealth = secondReady.health
  daemonPids.push(secondHealth?.terminalDaemon?.pid)
  if (secondHealth?.terminalDaemon?.pid !== firstHealth.terminalDaemon.pid) {
    fail(
      `Bun restart did not adopt daemon ${firstHealth.terminalDaemon.pid} -> ${secondHealth?.terminalDaemon?.pid}`
    )
  }
  if (
    !hasOrcadLifecycleOutputLine(readTerminal(secondReady.pairing.url, terminal.handle), marker)
  ) {
    fail('Bun terminal scrollback did not survive runtime restart')
  }
  await probeTerminal(secondReady.pairing.url, terminalHandle, `${marker}_restart`)
  if (migrationMode) {
    await stopRuntime(runtime.child)
    runtime = startRuntime(
      selectOrcadLifecycleRuntime({
        migrationMode,
        bundledBun: bun,
        hostNodeRuntime
      }),
      initialArtifactDir
    )
    const rollbackReady = await runtime.ready
    activePairing = rollbackReady.pairing.url
    const rollbackHealth = rollbackReady.health
    daemonPids.push(rollbackHealth?.terminalDaemon?.pid)
    if (rollbackHealth?.runtimeKind !== 'node' || rollbackHealth?.ptyBackend !== 'node-pty') {
      fail(`rollback did not run under Node: ${JSON.stringify(rollbackHealth)}`)
    }
    if (rollbackHealth?.terminalDaemon?.pid !== firstHealth.terminalDaemon.pid) {
      fail('Node rollback replaced the live daemon')
    }
    if (
      !hasOrcadLifecycleOutputLine(readTerminal(rollbackReady.pairing.url, terminal.handle), marker)
    ) {
      fail('terminal scrollback did not survive Bun-to-Node rollback')
    }
    await probeTerminal(rollbackReady.pairing.url, terminalHandle, `${marker}_rollback`)
  }
  succeeded = true
  console.log(
    JSON.stringify({
      ok: true,
      runtime: migrationMode ? 'node-bun-node' : 'bun',
      platform: `${process.platform}-${process.arch}`,
      daemonPid: firstHealth.terminalDaemon.pid,
      marker,
      checks: [
        'readiness',
        'repo-rpc',
        'worktree-rpc',
        'pty-output',
        'daemon-survival',
        'daemon-reattach',
        'scrollback-replay',
        'fresh-input-after-restart',
        ...(migrationMode
          ? ['node-bun-adoption', 'bun-node-rollback', 'fresh-input-after-rollback']
          : [])
      ]
    })
  )
} finally {
  if (runtime?.child.exitCode === null && activePairing && terminalHandle) {
    try {
      cli(activePairing, ['terminal', 'close', '--terminal', terminalHandle])
    } catch (error) {
      console.error(`Lifecycle terminal cleanup failed: ${error.message}`)
      process.exitCode = 1
    }
  }
  if (runtime?.child.exitCode === null) {
    await stopRuntime(runtime.child).catch(() => runtime.child.kill('SIGKILL'))
  }
  // A daemon can start even when the runtime cannot connect to its socket for readiness.
  const daemonDir = join(dataRoot, 'daemon')
  for (const name of existsSync(daemonDir) ? readdirSync(daemonDir) : []) {
    if (!/^daemon-v\d+\.pid$/.test(name)) {
      continue
    }
    try {
      const record = JSON.parse(readFileSync(join(daemonDir, name), 'utf8'))
      if (
        [artifactDir, initialArtifactDir].some(
          (directory) => record.entryPath === join(directory, 'daemon-entry.js')
        ) &&
        Number.isSafeInteger(record.pid) &&
        record.pid > 0
      ) {
        daemonPids.push(record.pid)
      }
    } catch {
      // An unreadable record does not authorize process termination.
    }
  }
  for (const pid of new Set(daemonPids.filter(Boolean))) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // The daemon may already have retired after the runtime cleanup.
    }
    await waitForLifecycleDaemonExit(pid)
  }
  if (!succeeded && process.env.ORCAD_E2E_KEEP_FAILED === '1') {
    console.error(`Retained failed lifecycle evidence: ${JSON.stringify({ dataRoot, repoRoot })}`)
  } else {
    if (worktreePath) {
      await removeLifecycleFixtureDirectory(worktreePath)
    }
    await removeLifecycleFixtureDirectory(repoRoot)
    await removeLifecycleFixtureDirectory(dataRoot)
  }
}
