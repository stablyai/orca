#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { cleanupIsolatedDaemons, isProcessAlive } from './remote-agent-session-process-cleanup.mjs'

const repoRoot = path.resolve(import.meta.dirname, '..', '..')
const { parsePaneKey } = createRequire(import.meta.url)(
  path.join(repoRoot, 'out', 'shared', 'stable-pane-id.js')
)
const clientScript = path.join(import.meta.dirname, 'remote-agent-session-repro-client.mjs')
const fixtureScript = path.join(import.meta.dirname, 'remote-agent-session-repro-fixture.mjs')
const writableShellScript = path.join(
  import.meta.dirname,
  'remote-agent-session-repro-writable-shell.mjs'
)
// Why: macOS limits Unix-domain socket paths to 104 bytes; the server profile
// creates nested daemon/runtime sockets below this disposable directory.
const scratch = mkdtempSync(path.join(os.tmpdir(), 'oa-'))
const profilePath = path.join(scratch, 'profile')
const projectPath = path.join(scratch, 'repo')
const binPath = path.join(scratch, 'bin')
const spawnMarkerPath = path.join(scratch, 'agent-spawns.txt')
const inputMarkerPath = path.join(scratch, 'agent-input.txt')
const exitTriggerPath = path.join(scratch, 'exit-agent')
const agentSessionToken = '--orca-repro-agent-session'
const childProcesses = new Set()
let server = null
let activePairingCode = null
let activeWorktree = null

try {
  mkdirSync(profilePath, { recursive: true })
  mkdirSync(projectPath, { recursive: true })
  mkdirSync(binPath, { recursive: true })
  execFileSync('git', ['init', projectPath], { stdio: 'ignore' })
  execFileSync(
    'git',
    [
      '-C',
      projectPath,
      '-c',
      'user.name=Orca Repro',
      '-c',
      'user.email=orca-repro@example.invalid',
      'commit',
      '--allow-empty',
      '-m',
      'Initial repro fixture'
    ],
    { stdio: 'ignore' }
  )
  const fixtureAgentPath = installFixtureAgent(binPath)
  writeFileSync(
    path.join(profilePath, 'orca-data.json'),
    JSON.stringify({
      settings: { agentCmdOverrides: { codex: quoteFixtureAgentCommand(fixtureAgentPath) } }
    })
  )

  const port = await reservePort()
  const firstReady = await startServer(port)
  const pairingCode = firstReady.pairing.url
  activePairingCode = pairingCode

  const addedRepo = await callClient(pairingCode, 'repo.add', { path: projectPath })
  assertOk(addedRepo, 'fixture repo registration')
  const worktreeList = await callClient(pairingCode, 'worktree.detectedList', {
    repo: `id:${addedRepo.result.repo.id}`
  })
  assertOk(worktreeList, 'fixture worktree discovery')
  const fixtureWorktree = worktreeList.result.worktrees.find(
    (candidate) => candidate.repoId === addedRepo.result.repo.id
  )
  if (!fixtureWorktree) {
    throw new Error(
      `fixture worktree was not discovered: ${JSON.stringify(worktreeList.result.worktrees)}`
    )
  }
  const worktree = `id:${fixtureWorktree.id}`
  activeWorktree = worktree
  const freshRequest = {
    clientOperationId: `${Date.now()}-0123456789abcdef0123456789abcdef`,
    worktree,
    agent: 'codex',
    presentation: 'focused'
  }
  const droppedFresh = await callClient(
    pairingCode,
    'terminal.createAgentSession',
    freshRequest,
    'drop-response'
  )
  if (!droppedFresh.droppedResponse) {
    throw new Error(`fresh response was not dropped: ${JSON.stringify(droppedFresh)}`)
  }
  let committedFreshTerminal = null
  await waitFor(async () => {
    const terminals = await callClient(pairingCode, 'terminal.list', { worktree })
    if (!terminals.ok || terminals.result.terminals.length !== 1 || countSpawnMarkers() !== 1) {
      return false
    }
    committedFreshTerminal = terminals.result.terminals[0]
    return true
  }, 'fresh host commit after response loss')
  const fresh = await callClient(pairingCode, 'terminal.createAgentSession', freshRequest)
  assertOk(fresh, 'focused fresh retry after response loss')
  if (fresh.result.disposition !== 'replayed') {
    throw new Error(`fresh retry was ${fresh.result.disposition}, expected replayed`)
  }
  assertTerminalInventoryIdentity(committedFreshTerminal, fresh.result.terminal)
  if (fresh.result.terminal.surface !== 'background') {
    throw new Error(`execution host returned ${fresh.result.terminal.surface}, expected background`)
  }
  if (countSpawnMarkers() !== 1) {
    throw new Error('fresh retry after response loss started a second agent')
  }
  await sendMarker(pairingCode, fresh.result.terminal.handle, 'fresh-agent-writable')
  const shell = await callClient(pairingCode, 'terminal.create', {
    worktree,
    command: fixtureCommand(writableShellScript, inputMarkerPath),
    presentation: 'background'
  })
  assertOk(shell, 'unrelated writable shell creation')
  await sendMarker(pairingCode, shell.result.terminal.handle, 'shell-writable')

  const resumeRequest = {
    kind: 'explicit',
    worktree,
    agent: 'codex',
    providerSession: { key: 'session_id', id: 'remote-authority-repro' },
    presentation: 'focused'
  }

  const [first, second] = await Promise.all([
    callClient(pairingCode, 'terminal.ensureAgentSession', resumeRequest),
    callClient(pairingCode, 'terminal.ensureAgentSession', resumeRequest)
  ])
  assertOk(first, 'first racing resume')
  assertOk(second, 'second racing resume')
  const dispositions = [first.result.disposition, second.result.disposition].sort()
  assertJsonEqual(dispositions, ['adopted', 'created'], 'race dispositions')
  assertSameTerminal(first.result.terminal, second.result.terminal)
  assertBackgroundSurface(first.result.terminal, 'first racing resume')
  assertBackgroundSurface(second.result.terminal, 'second racing resume')
  await waitFor(() => countSpawnMarkers() === 2, 'exactly one fresh and one resumed spawn')

  const retry = await callClient(pairingCode, 'terminal.ensureAgentSession', resumeRequest)
  assertOk(retry, 'resume retry')
  if (retry.result.disposition !== 'adopted') {
    throw new Error(`resume retry was ${retry.result.disposition}, expected adopted`)
  }
  assertSameTerminal(first.result.terminal, retry.result.terminal)
  assertBackgroundSurface(retry.result.terminal, 'resume retry')
  const spawnCountAfterRetry = countSpawnMarkers()
  if (spawnCountAfterRetry !== 2) {
    throw new Error(
      `resume retry changed spawn count to ${spawnCountAfterRetry}: ${readFileSync(spawnMarkerPath, 'utf8')}`
    )
  }
  await sendMarker(pairingCode, retry.result.terminal.handle, 'resume-agent-writable')

  const closed = await callClient(pairingCode, 'terminal.close', {
    terminal: first.result.terminal.handle
  })
  assertOk(closed, 'fixture terminal close')
  await waitFor(async () => {
    const [terminals, tabs] = await Promise.all([
      callClient(pairingCode, 'terminal.list', { worktree }),
      callClient(pairingCode, 'session.tabs.list', { worktree })
    ])
    const expectedParentTabIds = [fresh.result.terminal.tabId, shell.result.terminal.tabId].sort()
    const actualParentTabIds = tabs.ok
      ? tabs.result.tabs
          .filter((tab) => tab.type === 'terminal')
          .map((tab) => tab.parentTabId)
          .sort()
      : []
    return (
      terminals.ok &&
      tabs.ok &&
      terminals.result.terminals.length === 2 &&
      terminals.result.terminals.some(
        (terminal) => terminal.handle === fresh.result.terminal.handle
      ) &&
      terminals.result.terminals.some(
        (terminal) => terminal.handle === shell.result.terminal.handle
      ) &&
      JSON.stringify(actualParentTabIds) === JSON.stringify(expectedParentTabIds) &&
      !actualParentTabIds.includes(first.result.terminal.tabId)
    )
  }, 'resume retirement without unrelated terminal loss')

  const oldTerminal = first.result.terminal
  if (!oldTerminal.tabId || !oldTerminal.paneKey || !oldTerminal.ptyId) {
    throw new Error(`retired terminal identity is incomplete: ${JSON.stringify(oldTerminal)}`)
  }
  const parsedPaneKey = parsePaneKey(oldTerminal.paneKey)
  if (!parsedPaneKey || parsedPaneKey.tabId !== oldTerminal.tabId) {
    throw new Error(`retired terminal pane identity is invalid: ${JSON.stringify(oldTerminal)}`)
  }
  const leafId = parsedPaneKey.leafId
  const staleWrite = await callClient(pairingCode, 'session.tabs.updatePaneLayout', {
    worktree,
    tabId: oldTerminal.tabId,
    root: { type: 'leaf', id: leafId, ptyId: oldTerminal.ptyId }
  })
  if (staleWrite.ok || staleWrite.error?.code !== 'invalid_argument') {
    throw new Error(`stale pane publication was not rejected: ${JSON.stringify(staleWrite)}`)
  }

  const [afterStaleTerminals, afterStaleTabs] = await Promise.all([
    callClient(pairingCode, 'terminal.list', { worktree }),
    callClient(pairingCode, 'session.tabs.list', { worktree })
  ])
  assertOk(afterStaleTerminals, 'terminal list after stale publication')
  assertOk(afterStaleTabs, 'tab list after stale publication')
  assertJsonEqual(
    afterStaleTerminals.result.terminals.map((terminal) => terminal.handle).sort(),
    [fresh.result.terminal.handle, shell.result.terminal.handle].sort(),
    'terminal stale-write resurrection'
  )
  assertJsonEqual(
    afterStaleTabs.result.tabs
      .filter((tab) => tab.type === 'terminal')
      .map((tab) => tab.parentTabId)
      .sort(),
    [fresh.result.terminal.tabId, shell.result.terminal.tabId].sort(),
    'tab stale-write resurrection'
  )
  if (
    afterStaleTabs.result.tabs.some(
      (tab) => tab.type === 'terminal' && tab.parentTabId === oldTerminal.tabId
    )
  ) {
    throw new Error('stale publication restored the retired resume tab')
  }

  const freshClosed = await callClient(pairingCode, 'terminal.close', {
    terminal: fresh.result.terminal.handle
  })
  assertOk(freshClosed, 'unrelated fresh terminal close')
  const remainingClosed = await callClient(pairingCode, 'terminal.stop', { worktree })
  assertOk(remainingClosed, 'isolated fixture terminal cleanup')
  await waitFor(async () => {
    const terminals = await callClient(pairingCode, 'terminal.list', { worktree })
    return terminals.ok && terminals.result.terminals.length === 0
  }, 'fresh terminal retirement')
  await waitFor(
    () =>
      readAgentSpawnPids().length === 2 &&
      readAgentSpawnPids().every((pid) => !isProcessAlive(pid)),
    'fixture agent process exit'
  )
  if (countSpawnMarkers() !== 2) {
    throw new Error(
      `cleanup observed a delayed extra spawn: ${readFileSync(spawnMarkerPath, 'utf8')}`
    )
  }

  await stopServer()
  const restarted = await startServer(port)
  const restartPairingCode = restarted.pairing.url
  activePairingCode = restartPairingCode
  const [afterRestartTerminals, afterRestartTabs] = await Promise.all([
    callClient(restartPairingCode, 'terminal.list', { worktree }),
    callClient(restartPairingCode, 'session.tabs.list', { worktree })
  ])
  assertOk(afterRestartTerminals, 'terminal list after restart')
  assertOk(afterRestartTabs, 'tab list after restart')
  assertJsonEqual(afterRestartTerminals.result.terminals, [], 'terminal resurrection after restart')
  assertJsonEqual(afterRestartTabs.result.tabs, [], 'tab resurrection after restart')
  const aliveAfterRestart = readAgentSpawnPids().filter(isProcessAlive)
  const spawnCountAfterRestart = countSpawnMarkers()
  if (aliveAfterRestart.length > 0 || spawnCountAfterRestart !== 2) {
    throw new Error(
      `restart restored or respawned a retired fixture agent: alive=${JSON.stringify(aliveAfterRestart)}, spawns=${JSON.stringify(readFileSync(spawnMarkerPath, 'utf8').trim().split(/\r?\n/))}`
    )
  }

  process.stdout.write(
    'PASS remote agent-session authority: fresh/resume focus isolation, response-loss replay, writable PTYs, one spawn per operation, retry adoption, unrelated survival, stale rejection, durable retirement\n'
  )
} finally {
  if (activePairingCode && activeWorktree) {
    await callClient(activePairingCode, 'terminal.stop', { worktree: activeWorktree }).catch(
      () => null
    )
  }
  writeFileSync(exitTriggerPath, '')
  await stopServer().catch(() => {})
  for (const child of childProcesses) {
    child.kill()
  }
  await cleanupIsolatedDaemons(profilePath)
  rmSync(scratch, { recursive: true, force: true })
}

function installFixtureAgent(targetDir) {
  const nodePath = process.execPath
  if (process.platform === 'win32') {
    const commandPath = path.join(targetDir, 'codex.cmd')
    writeFileSync(commandPath, `@"${nodePath}" "${fixtureScript}" %*\r\n`)
    return commandPath
  }
  const commandPath = path.join(targetDir, 'codex')
  writeFileSync(
    commandPath,
    `#!/bin/sh\nexec ${shellQuote(nodePath)} ${shellQuote(fixtureScript)} "$@"\n`
  )
  chmodSync(commandPath, 0o755)
  return commandPath
}

function quoteFixtureAgentCommand(commandPath) {
  return process.platform === 'win32'
    ? `"${commandPath.replaceAll('"', '""')}" ${agentSessionToken}`
    : `${shellQuote(commandPath)} ${agentSessionToken}`
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function fixtureCommand(scriptPath, markerPath) {
  if (process.platform === 'win32') {
    return [process.execPath, scriptPath, markerPath]
      .map((value) => `"${value.replaceAll('"', '""')}"`)
      .join(' ')
  }
  return [process.execPath, scriptPath, markerPath].map(shellQuote).join(' ')
}

async function reservePort() {
  return await new Promise((resolve, reject) => {
    const listener = net.createServer()
    listener.once('error', reject)
    listener.listen(0, '127.0.0.1', () => {
      const address = listener.address()
      const port = typeof address === 'object' && address ? address.port : 0
      listener.close((error) => (error ? reject(error) : resolve(port)))
    })
  })
}

async function startServer(port) {
  const electronPath = await import('electron').then((module) => module.default)
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH'
  const pathDelimiter = process.platform === 'win32' ? ';' : ':'
  const env = {
    ...process.env,
    [pathKey]: `${binPath}${pathDelimiter}${process.env[pathKey] ?? ''}`,
    ORCA_DEV_USER_DATA_PATH: profilePath,
    ORCA_USER_DATA_PATH: profilePath,
    ORCA_REPRO_SPAWN_MARKER: spawnMarkerPath,
    ORCA_REPRO_EXIT_TRIGGER: exitTriggerPath,
    ORCA_REPRO_INPUT_MARKER: inputMarkerPath,
    ORCA_REPRO_AGENT_SESSION_TOKEN: agentSessionToken,
    ...(process.platform === 'linux' ? { ELECTRON_DISABLE_SANDBOX: '1' } : {})
  }
  server = spawn(
    electronPath,
    [
      repoRoot,
      '--serve',
      '--serve-json',
      '--serve-port',
      String(port),
      '--serve-pairing-address',
      `127.0.0.1:${port}`
    ],
    { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
  )
  childProcesses.add(server)
  let stderr = ''
  server.stderr.on('data', (chunk) => {
    stderr += String(chunk)
  })
  const lines = createInterface({ input: server.stdout })
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`server readiness timed out\n${stderr}`))
    }, 30_000)
    lines.on('line', (line) => {
      try {
        const parsed = JSON.parse(line)
        if (parsed.type === 'orca_server_ready' && parsed.pairing?.url) {
          clearTimeout(timeout)
          resolve(parsed)
        }
      } catch {
        // Startup diagnostics are allowed before the one structured ready line.
      }
    })
    server.once('exit', (code) => {
      clearTimeout(timeout)
      reject(new Error(`server exited before readiness with code ${code}\n${stderr}`))
    })
    server.once('error', reject)
  })
}

async function stopServer() {
  const current = server
  server = null
  if (!current) {
    return
  }
  childProcesses.delete(current)
  if (current.exitCode !== null) {
    return
  }
  current.kill('SIGTERM')
  await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      current.kill('SIGKILL')
      resolve()
    }, 8_000)
    current.once('exit', () => {
      clearTimeout(timeout)
      resolve()
    })
  })
}

async function callClient(pairingCode, method, params, responseMode) {
  return await new Promise((resolve, reject) => {
    const args = [clientScript, pairingCode, method, JSON.stringify(params)]
    if (responseMode) {
      args.push(responseMode)
    }
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    childProcesses.add(child)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.once('error', reject)
    child.once('exit', (code) => {
      childProcesses.delete(child)
      try {
        const response = JSON.parse(stdout.trim())
        if (code !== 0 && response.ok !== false) {
          reject(new Error(`client ${method} exited ${code}: ${stderr}`))
          return
        }
        resolve(response)
      } catch (error) {
        reject(
          new Error(`client ${method} returned invalid JSON: ${stdout}\n${stderr}`, {
            cause: error
          })
        )
      }
    })
  })
}

function countSpawnMarkers() {
  if (!existsSync(spawnMarkerPath)) {
    return 0
  }
  return readFileSync(spawnMarkerPath, 'utf8').split(/\r?\n/).filter(Boolean).length
}

function readAgentSpawnPids() {
  if (!existsSync(spawnMarkerPath)) {
    return []
  }
  return readFileSync(spawnMarkerPath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => Number(line.split(':', 1)[0]))
    .filter((pid) => Number.isInteger(pid) && pid > 0)
}

function assertBackgroundSurface(terminal, description) {
  if (terminal.surface !== 'background') {
    throw new Error(`${description} returned ${terminal.surface}, expected background`)
  }
}

async function sendMarker(pairingCode, terminal, marker) {
  const response = await callClient(pairingCode, 'terminal.send', {
    terminal,
    text: `${marker}\n`
  })
  assertOk(response, `${marker} terminal send`)
  if (!response.result.send.accepted) {
    throw new Error(`${marker} terminal send was refused`)
  }
  await waitFor(
    () => existsSync(inputMarkerPath) && readFileSync(inputMarkerPath, 'utf8').includes(marker),
    `${marker} input delivery`
  )
}

async function waitFor(predicate, description) {
  const deadline = Date.now() + 15_000
  let lastError = null
  while (Date.now() < deadline) {
    try {
      if (await predicate()) {
        return
      }
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`timed out waiting for ${description}`, { cause: lastError })
}

function assertOk(response, description) {
  if (!response?.ok) {
    throw new Error(`${description} failed: ${JSON.stringify(response)}`)
  }
}

function assertSameTerminal(left, right) {
  assertJsonEqual(
    [left.handle, left.tabId, left.paneKey, left.ptyId],
    [right.handle, right.tabId, right.paneKey, right.ptyId],
    'canonical terminal identity'
  )
}

function assertTerminalInventoryIdentity(left, right) {
  assertJsonEqual(
    [left.handle, left.tabId, left.ptyId],
    [right.handle, right.tabId, right.ptyId],
    'committed terminal inventory identity'
  )
}

function assertJsonEqual(actual, expected, description) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${description}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`
    )
  }
}
