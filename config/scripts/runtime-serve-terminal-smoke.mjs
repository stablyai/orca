// Drive built Electron/orcad server through public pairing/RPC, create terminal and require real command output, then shutdown; --browser also checks provider actions.
// Boot/port/host.platform can pass with dead PTYs when renderer fallback times out; both targets must satisfy the same end-to-end contract.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomBytes } from 'node:crypto'
import process from 'node:process'
import {
  ORCAD_CLI_ENTRY_FILENAME,
  ORCAD_SERVER_ENTRY_FILENAME
} from '../../src/shared/orcad-artifacts.ts'
import { packagedNodeRuntimePath } from './build-orcad-node.mjs'
import { currentTarget } from './server-build-target.mjs'

const projectDir = resolve(import.meta.dirname, '../..')
const serveEntry = join(projectDir, 'out', 'main', 'index.js')
const ORCAD_DIR = join(projectDir, 'out', 'orcad')
const ORCAD_ENTRY = join(ORCAD_DIR, ORCAD_SERVER_ENTRY_FILENAME)
const READY_TIMEOUT_MS = 120_000
const OUTPUT_TIMEOUT_MS = 30_000
const SHUTDOWN_TIMEOUT_MS = 15_000
// Offset the port when a developer's own `orca serve` is already using it.
const PORT = 6800 + Math.floor(Number(process.env.ORCA_SMOKE_PORT_OFFSET ?? '0'))

function log(message) {
  process.stdout.write(`[serve-terminal-smoke] ${message}\n`)
}

function fail(message) {
  process.stderr.write(`[serve-terminal-smoke] FAIL: ${message}\n`)
  process.exitCode = 1
}

// Use packaged Node/CLI for orcad and checkout desktop CLI for Electron.
export function resolveCli(target, root = projectDir) {
  if (target === 'orcad') {
    const directory = join(root, 'out', 'orcad')
    const built = join(directory, ORCAD_CLI_ENTRY_FILENAME)
    if (!existsSync(built)) {
      throw new Error(`Missing packaged Orcad CLI at ${built}; run pnpm build:orcad`)
    }
    return {
      command: packagedNodeRuntimePath(directory, currentTarget()),
      prefix: [built]
    }
  }
  const built = join(root, 'out', 'cli', 'index.js')
  return existsSync(built)
    ? { command: process.execPath, prefix: [built] }
    : { command: 'orca', prefix: [] }
}

function orca(pairingCode, args) {
  const cli = resolveCli(smokeTarget())
  const result = spawnSync(
    cli.command,
    [...cli.prefix, ...args, '--pairing-code', pairingCode, '--json'],
    {
      encoding: 'utf8',
      // Keep argv shell-free so pairing code is not re-split by a command interpreter.
      shell: false
    }
  )
  if (result.error) {
    throw new Error(`orca ${args[0]} failed to spawn: ${result.error.message}`)
  }
  if (result.status !== 0) {
    throw new Error(
      `orca ${args.join(' ')} exited ${result.signal ?? result.status}:\n${result.stderr || result.stdout}`
    )
  }
  const line = (result.stdout ?? '').trim()
  if (!line.startsWith('{')) {
    throw new Error(`orca ${args.join(' ')} produced no JSON:\n${result.stdout}\n${result.stderr}`)
  }
  const parsed = JSON.parse(line)
  if (parsed.ok === false) {
    throw new Error(
      `orca ${args.join(' ')} returned ${parsed.error?.code}: ${parsed.error?.message}`
    )
  }
  return parsed.result
}

function waitForReady(child) {
  return new Promise((resolvePromise, rejectPromise) => {
    let buffered = ''
    let serverErr = ''
    const timer = setTimeout(
      () => rejectPromise(new Error(`no ready payload within ${READY_TIMEOUT_MS}ms`)),
      READY_TIMEOUT_MS
    )
    // Drain stderr to avoid pipe backpressure and retain actionable boot errors.
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      serverErr += chunk
    })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffered += chunk
      for (const line of buffered.split('\n')) {
        if (!line.startsWith('{')) {
          continue
        }
        try {
          const payload = JSON.parse(line)
          if (payload.type === 'orca_server_ready') {
            clearTimeout(timer)
            resolvePromise(payload)
            return
          }
        } catch {
          // Partial line; wait for the rest.
        }
      }
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      rejectPromise(
        new Error(
          `server exited with ${code} before signalling ready${
            serverErr.trim() ? `:\n${serverErr.trim()}` : ' (no stderr)'
          }`
        )
      )
    })
  })
}

function pairingCodeFrom(payload) {
  const url = payload?.pairing?.url
  if (!url) {
    throw new Error('ready payload carried no pairing offer')
  }
  const code = new URL(url).searchParams.get('code')
  if (!code) {
    throw new Error(`pairing url had no code: ${url}`)
  }
  return code
}

async function waitForNonce(pairingCode, terminalHandle, nonce) {
  const deadline = Date.now() + OUTPUT_TIMEOUT_MS
  while (Date.now() < deadline) {
    const read = orca(pairingCode, ['terminal', 'read', '--terminal', terminalHandle])
    const tail = (read?.terminal?.tail ?? []).map((entry) => String(entry)).join('\n')
    if (tail.includes(nonce)) {
      return true
    }
    await new Promise((r) => setTimeout(r, 1_000))
  }
  return false
}

// Share pairing/list/create/round-trip assertions across Electron and Node targets so acceptance cannot drift.
function smokeTarget() {
  // Use CLI flag for package-script portability; inline FOO=bar env syntax fails on Windows.
  const flagIndex = process.argv.indexOf('--target')
  return flagIndex !== -1
    ? process.argv[flagIndex + 1]
    : (process.env.ORCA_SMOKE_TARGET ?? 'electron')
}

function resolveLaunch(userDataDir) {
  const target = smokeTarget()
  if (target === 'orcad') {
    return {
      label: `orcad (${ORCAD_ENTRY})`,
      command: packagedNodeRuntimePath(ORCAD_DIR, currentTarget()),
      args: [ORCAD_ENTRY, '--port', String(PORT), '--json'],
      env: { ORCA_USER_DATA: userDataDir }
    }
  }
  if (target !== 'electron') {
    throw new Error(
      `--target (or ORCA_SMOKE_TARGET) must be 'electron' or 'orcad', got '${target}'`
    )
  }
  const serveArgs = [
    serveEntry,
    '--serve',
    '--serve-port',
    String(PORT),
    '--serve-json',
    `--user-data-dir=${userDataDir}`
  ]
  const override = process.env.ORCA_SMOKE_ELECTRON
  return {
    label: `electron (${serveEntry})`,
    command: override ?? 'npx',
    args: override ? serveArgs : ['electron', ...serveArgs],
    env: { ORCA_DEV_USER_DATA_PATH: userDataDir }
  }
}

function seedGitRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'orca-smoke-repo-'))
  writeFileSync(join(dir, 'README.md'), '# orca smoke\n')
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
    if (result.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
    }
  }
  git('init', '-b', 'main')
  git('config', 'user.email', 'smoke@orca.test')
  git('config', 'user.name', 'Orca Smoke')
  git('add', '-A')
  git('commit', '-m', 'seed')
  return dir
}

async function main() {
  const userDataDir = mkdtempSync(join(tmpdir(), 'orca-serve-smoke-'))
  const launch = resolveLaunch(userDataDir)
  log(`booting ${launch.label} on port ${PORT} with userData ${userDataDir}`)

  // Track real-root worktree separately from temp profile or finally leaks it.
  let seeded = null
  let pairing = null

  const child = spawn(launch.command, launch.args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...launch.env }
  })

  try {
    const ready = await waitForReady(child)
    log(`ready: ${ready.advertisedEndpoint}`)
    const pairingCode = pairingCodeFrom(ready)
    pairing = pairingCode

    // Seed hermetic repo for clean CI and exercise repo.add/worktree.create instead of relying on existing registration.
    const repoPath = seedGitRepo()
    seeded = { repoPath }
    log(`seeded repo at ${repoPath}`)
    const repo = orca(pairingCode, ['repo', 'add', '--path', repoPath])?.repo
    if (!repo?.id) {
      throw new Error('repo.add returned no repo id')
    }

    const worktreeName = `smoke-${randomBytes(4).toString('hex')}`
    const created = orca(pairingCode, [
      'worktree',
      'create',
      '--repo',
      `id:${repo.id}`,
      '--name',
      worktreeName,
      '--setup',
      'skip'
    ])?.worktree
    if (!created?.id) {
      throw new Error('worktree.create returned no worktree id')
    }
    seeded.worktreeId = created.id
    log(`created worktree ${created.id}`)

    // Use show to verify this persisted worktree: capped list may omit it in shared dev profile.
    const shown = orca(pairingCode, ['worktree', 'show', '--worktree', created.id])?.worktree
    if (shown?.id !== created.id) {
      throw new Error('worktree.create succeeded but worktree.show cannot resolve it')
    }
    log(`server resolves ${shown.id}`)
    if (process.argv.includes('--browser')) {
      const status = orca(pairingCode, ['status'])
      if (!status?.runtime?.capabilities?.includes('browser.headless.v1')) {
        throw new Error(
          `status omitted browser.headless.v1: ${JSON.stringify(status?.runtime?.capabilities)}`
        )
      }
      const fixturePath = join(userDataDir, 'browser-smoke.html')
      writeFileSync(
        fixturePath,
        '<!doctype html><title>Orcad Browser Smoke</title><main>browser-ready</main>'
      )
      const browserPageId = orca(pairingCode, [
        'tab',
        'create',
        '--worktree',
        created.id,
        '--url',
        'about:blank'
      ])?.browserPageId
      if (!browserPageId) {
        throw new Error('browser.tabCreate returned no browser page id')
      }
      const targetFlags = ['--worktree', created.id, '--page', browserPageId]
      const targetUrl = pathToFileURL(fixturePath).href
      const navigation = orca(pairingCode, ['goto', ...targetFlags, '--url', targetUrl])
      if (navigation?.url !== targetUrl || navigation?.title !== 'Orcad Browser Smoke') {
        throw new Error(`browser.goto returned the wrong page: ${JSON.stringify(navigation)}`)
      }
      const evaluated = orca(pairingCode, [
        'eval',
        ...targetFlags,
        '--expression',
        'document.querySelector("main")?.textContent'
      ])
      if (evaluated?.result !== 'browser-ready') {
        throw new Error(`browser.eval returned ${JSON.stringify(evaluated)}`)
      }
      const screenshot = orca(pairingCode, ['screenshot', ...targetFlags])
      if (screenshot?.format !== 'png' || !screenshot.path || !statSync(screenshot.path).size) {
        throw new Error('browser.screenshot saved no PNG file')
      }
      log('browser navigate/evaluate/screenshot round trip OK')
    }

    const terminal = orca(pairingCode, ['terminal', 'create', '--worktree', created.id])?.terminal
    if (!terminal?.handle) {
      throw new Error('terminal.create returned no handle')
    }
    log(`created ${terminal.handle}`)

    // Why invoke node rather than `echo`: the shell differs per platform, node does not.
    const nonce = randomBytes(8).toString('hex')
    orca(pairingCode, [
      'terminal',
      'send',
      '--terminal',
      terminal.handle,
      '--text',
      `"${process.execPath}" -e "console.log('ORCA_SMOKE_' + '${nonce}')"`,
      '--enter'
    ])

    if (!(await waitForNonce(pairingCode, terminal.handle, `ORCA_SMOKE_${nonce}`))) {
      throw new Error(
        `terminal produced no output containing ${nonce} within ${OUTPUT_TIMEOUT_MS}ms — ` +
          `the server started and answered RPC, but its PTY path is dead`
      )
    }
    log('terminal round trip OK')
    if (launch.env.ORCA_USER_DATA && process.platform !== 'win32') {
      const cliNonce = randomBytes(8).toString('hex')
      orca(pairingCode, [
        'terminal',
        'send',
        '--terminal',
        terminal.handle,
        '--text',
        `orca status && orca worktree ps --json && printf 'ORCA_CLI_%s\\n' '${cliNonce}'`,
        '--enter'
      ])
      if (!(await waitForNonce(pairingCode, terminal.handle, `ORCA_CLI_${cliNonce}`))) {
        throw new Error('The managed terminal could not run the execution host CLI')
      }
      log('execution host CLI round trip OK')
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  } finally {
    // Why before SIGTERM: worktree removal is a server operation, so it needs the server.
    if (seeded?.worktreeId && pairing) {
      const cleanupCli = resolveCli(smokeTarget())
      const removed = spawnSync(
        cleanupCli.command,
        [
          ...cleanupCli.prefix,
          'worktree',
          'rm',
          '--worktree',
          seeded.worktreeId,
          '--pairing-code',
          pairing,
          '--force',
          '--json'
        ],
        { encoding: 'utf8' }
      )
      // Remove empty workspaces/repo parent left behind by worktree rm to avoid leaks.
      const worktreePath = seeded.worktreeId.split('::')[1]
      if (removed.status === 0 && worktreePath) {
        rmSync(dirname(worktreePath), { recursive: true, force: true })
      }
      if (removed.status !== 0) {
        log(
          `WARN: could not remove seeded worktree ${seeded.worktreeId}: ` +
            `${(removed.stderr?.trim() || removed.stdout?.trim() || '').replace(/\s+/g, ' ')} (exit ${removed.status})`
        )
      }
    }
    // Guard already-exited server or waiting for another exit stacks bogus shutdown error over boot failure.
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      const exited = await Promise.race([
        new Promise((r) => child.on('exit', () => r(true))),
        // Unref losing timeout so it bounds wait without keeping process alive after race settles.
        new Promise((r) => setTimeout(() => r(false), SHUTDOWN_TIMEOUT_MS).unref())
      ])
      if (!exited) {
        child.kill('SIGKILL')
        fail(`server did not exit within ${SHUTDOWN_TIMEOUT_MS}ms of SIGTERM`)
      }
    }
    rmSync(userDataDir, { recursive: true, force: true })
    if (seeded?.repoPath) {
      rmSync(seeded.repoPath, { recursive: true, force: true })
    }
  }

  if (!process.exitCode) {
    log('PASS')
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main()
}
