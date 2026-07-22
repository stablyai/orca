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
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'

const repoRoot = path.resolve(import.meta.dirname, '..', '..')
const clientScript = path.join(import.meta.dirname, 'remote-agent-session-repro-client.mjs')
const fixtureScript = path.join(import.meta.dirname, 'remote-agent-session-repro-fixture.mjs')
// Why: macOS limits Unix-domain socket paths to 104 bytes; the server profile
// creates nested daemon/runtime sockets below this disposable directory.
const scratch = mkdtempSync(path.join(os.tmpdir(), 'oa-'))
const profilePath = path.join(scratch, 'profile')
const projectPath = path.join(scratch, 'repo')
const binPath = path.join(scratch, 'bin')
const spawnMarkerPath = path.join(scratch, 'agent-spawns.txt')
const exitTriggerPath = path.join(scratch, 'exit-agent')
const childProcesses = new Set()
let server = null

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
  const resumeRequest = {
    kind: 'explicit',
    worktree,
    agent: 'codex',
    providerSession: { key: 'session_id', id: 'remote-authority-repro' },
    presentation: 'background'
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
  await waitFor(() => countSpawnMarkers() === 1, 'exactly one fixture agent spawn')

  const retry = await callClient(pairingCode, 'terminal.ensureAgentSession', resumeRequest)
  assertOk(retry, 'resume retry')
  if (retry.result.disposition !== 'adopted') {
    throw new Error(`resume retry was ${retry.result.disposition}, expected adopted`)
  }
  assertSameTerminal(first.result.terminal, retry.result.terminal)
  if (countSpawnMarkers() !== 1) {
    throw new Error('resume retry started a second agent')
  }

  const closed = await callClient(pairingCode, 'terminal.close', {
    terminal: first.result.terminal.handle
  })
  assertOk(closed, 'fixture terminal close')
  await waitFor(async () => {
    const [terminals, tabs] = await Promise.all([
      callClient(pairingCode, 'terminal.list', { worktree }),
      callClient(pairingCode, 'session.tabs.list', { worktree })
    ])
    return (
      terminals.ok &&
      tabs.ok &&
      terminals.result.terminals.length === 0 &&
      tabs.result.tabs.length === 0
    )
  }, 'exited surface retirement')

  const oldTerminal = first.result.terminal
  if (oldTerminal.tabId && oldTerminal.paneKey) {
    const leafId = oldTerminal.paneKey.slice(oldTerminal.paneKey.indexOf(':') + 1)
    await callClient(pairingCode, 'session.tabs.updatePaneLayout', {
      worktree,
      tabId: oldTerminal.tabId,
      root: { type: 'leaf', id: leafId, ptyId: oldTerminal.ptyId ?? undefined }
    }).catch(() => null)
  }

  const [afterStaleTerminals, afterStaleTabs] = await Promise.all([
    callClient(pairingCode, 'terminal.list', { worktree }),
    callClient(pairingCode, 'session.tabs.list', { worktree })
  ])
  assertOk(afterStaleTerminals, 'terminal list after stale publication')
  assertOk(afterStaleTabs, 'tab list after stale publication')
  assertJsonEqual(afterStaleTerminals.result.terminals, [], 'terminal stale-write resurrection')
  assertJsonEqual(afterStaleTabs.result.tabs, [], 'tab stale-write resurrection')

  await stopServer()
  const restarted = await startServer(port)
  const restartPairingCode = restarted.pairing.url
  const [afterRestartTerminals, afterRestartTabs] = await Promise.all([
    callClient(restartPairingCode, 'terminal.list', { worktree }),
    callClient(restartPairingCode, 'session.tabs.list', { worktree })
  ])
  assertOk(afterRestartTerminals, 'terminal list after restart')
  assertOk(afterRestartTabs, 'tab list after restart')
  assertJsonEqual(afterRestartTerminals.result.terminals, [], 'terminal resurrection after restart')
  assertJsonEqual(afterRestartTabs.result.tabs, [], 'tab resurrection after restart')

  process.stdout.write(
    'PASS remote agent-session authority: one spawn, retry adoption, durable exit retirement, no restart resurrection\n'
  )
} finally {
  await stopServer().catch(() => {})
  for (const child of childProcesses) {
    child.kill()
  }
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
    ? `"${commandPath.replaceAll('"', '""')}"`
    : shellQuote(commandPath)
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`
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

async function callClient(pairingCode, method, params) {
  return await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [clientScript, pairingCode, method, JSON.stringify(params)],
      { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
    )
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

function assertJsonEqual(actual, expected, description) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${description}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`
    )
  }
}
