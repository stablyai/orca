/**
 * Boots the BUILT headless runtime server (`out/main/index.js --serve`), pairs a real
 * client to it over the advertised endpoint, creates a terminal, runs a command in it,
 * and asserts the output comes back — then shuts down.
 *
 * Why this exists: "the server started" proves almost nothing. The runtime dispatches
 * terminal creation into OrcaRuntimeService, and without an installed headless PTY
 * controller that path falls through to a renderer reply that never arrives and times
 * out after ten seconds. A boot probe, a port bind, and a `host.platform` call all pass
 * against a server whose terminals are dead. Only a PTY round trip catches it.
 *
 * This is also the acceptance gate for a future Node-only backend
 * (docs/design/node-only-runtime-backend.html): the same script should pass against
 * `orcad` unchanged, because it drives nothing but the public pairing + RPC surface.
 *
 * Hard assertions (fail the job):
 *   - the server emits its ready payload with a pairing offer,
 *   - a paired client can list worktrees and create a terminal,
 *   - a command run in that terminal produces its output,
 *   - the server exits when asked.
 * Optional `--browser` assertions:
 *   - create, navigate, evaluate, and screenshot through the selected host provider.
 */
import { spawn, spawnSync } from 'node:child_process'
import { build } from 'esbuild'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomBytes } from 'node:crypto'
import process from 'node:process'
import {
  readRuntimeServeSmokePid,
  runtimeServeSmokeProcessState,
  resolveRuntimeServeSmokeLaunch,
  verifyRuntimeServeSmokeFinalExport
} from './runtime-serve-smoke-launch.mjs'
import { prepareServerShutdown, stopServer } from './runtime-serve-smoke-shutdown.mjs'

const projectDir = resolve(import.meta.dirname, '../..')
const READY_TIMEOUT_MS = 120_000
const OUTPUT_TIMEOUT_MS = 30_000
// Why a random high port: a fixed one collides with a developer's own `orca serve`.
const PORT = 6800 + Math.floor(Number(process.env.ORCA_SMOKE_PORT_OFFSET ?? '0'))

function log(message) {
  process.stdout.write(`[serve-terminal-smoke] ${message}\n`)
}

function fail(message) {
  process.stderr.write(`[serve-terminal-smoke] FAIL: ${message}\n`)
  process.exitCode = 1
}

/**
 * Prefer the CLI built from this checkout over whatever `orca` is on PATH: it is the
 * version under test, and a CI runner has no installed Orca app to fall back on.
 */
function resolveCli() {
  const built = join(projectDir, 'out', 'cli', 'cli-bin.js')
  if (!existsSync(built)) {
    throw new Error('Build the CLI before running the runtime acceptance test.')
  }
  return { command: process.execPath, prefix: [built] }
}

/** The `orca` CLI, driven with an explicit pairing code so it targets this server only. */
function orca(pairingCode, args) {
  const cli = resolveCli()
  const result = spawnSync(
    cli.command,
    [...cli.prefix, ...args, '--pairing-code', pairingCode, '--json'],
    {
      encoding: 'utf8',
      // Why not shell:true — argument encoding is handled by spawnSync; a shell would
      // re-split the pairing code, which is base64url and can contain '='.
      shell: false
    }
  )
  if (result.error) {
    throw new Error(`orca ${args[0]} failed to spawn: ${result.error.message}`)
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
    // Why read stderr at all: an unread pipe can fill and block the child, and without it
    // a boot failure surfaces only as "exited with 1", which says nothing actionable.
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

/** A throwaway git repo with one commit, so `repo add` has something real to register. */
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
  const launch = resolveRuntimeServeSmokeLaunch(projectDir, userDataDir, PORT)
  log(`booting ${launch.label} on port ${PORT} with userData ${userDataDir}`)

  // Why tracked out here: the worktree lands in the real workspaces root, not the temp
  // profile, so the finally block has to remove it explicitly or every run leaks one.
  const folderWorkspace = process.argv.includes('--folder')
  let seeded = null
  let pairing = null
  let servingPid = null

  const diagnostics = []
  const startServer = () => {
    const child = spawn(launch.command, launch.args, {
      stdio: launch.lockPath ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, ...launch.env, ORCA_BACKGROUND_LAUNCH: '1' }
    })
    if (launch.lockPath) {
      prepareServerShutdown(child)
    }
    const output = { stdout: '', stderr: '' }
    diagnostics.push(output)
    for (const stream of ['stdout', 'stderr']) {
      child[stream].on('data', (data) => {
        output[stream] = (output[stream] + data.toString()).slice(-32_768)
      })
    }
    return child
  }
  let child = startServer()

  try {
    const ready = await waitForReady(child)
    servingPid = readRuntimeServeSmokePid(userDataDir)
    log(`ready: ${ready.advertisedEndpoint}`)
    let pairingCode = pairingCodeFrom(ready)
    pairing = pairingCode

    // Why seed instead of using whatever the profile already holds: a hermetic repo makes
    // this runnable on a clean CI box, keeps the assertion deterministic, and exercises
    // repo.add + worktree.create rather than assuming someone else registered a worktree.
    const repoPath = folderWorkspace
      ? mkdtempSync(join(tmpdir(), 'orca-smoke-folder-'))
      : seedGitRepo()
    seeded = { repoPath }
    log(`seeded ${folderWorkspace ? 'folder' : 'git repo'} at ${repoPath}`)
    let repo
    if (folderWorkspace) {
      // The public RPC supports folder registration; the repo-add CLI flag does not.
      const { RuntimeClient } = await import(
        pathToFileURL(join(projectDir, 'out/cli/runtime/client.js')).href
      )
      const client = new RuntimeClient(userDataDir, 60_000, pairingCode, null)
      repo = (await client.call('repo.add', { path: repoPath, kind: 'folder' })).result.repo
      if (repo.kind !== 'folder' || existsSync(join(repoPath, '.git'))) {
        throw new Error('Folder registration unexpectedly created a git workspace')
      }
      writeFileSync(join(repoPath, 'keep.txt'), 'User-owned folder contents')
    } else {
      repo = orca(pairingCode, ['repo', 'add', '--path', repoPath])?.repo
    }
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

    // Why `show` and not membership in `list`: list is capped, and the Electron target
    // reads a shared dev profile that can already hold more worktrees than the cap. The
    // point is that the server persisted and can resolve THIS worktree.
    const shown = orca(pairingCode, ['worktree', 'show', '--worktree', created.id])?.worktree
    if (shown?.id !== created.id) {
      throw new Error('worktree.create succeeded but worktree.show cannot resolve it')
    }
    log(`server resolves ${shown.id}`)
    if (process.argv.includes('--restart')) {
      await stopServer(child, launch.lockPath, launch.ownerLoss, servingPid)
      if (launch.verifyFinalExport && folderWorkspace) {
        verifyRuntimeServeSmokeFinalExport(userDataDir, created.id)
        log('final profile export contains the new workspace OK')
      }
      child = startServer()
      pairingCode = pairingCodeFrom(await waitForReady(child))
      servingPid = readRuntimeServeSmokePid(userDataDir)
      pairing = pairingCode
      const restored = orca(pairingCode, ['worktree', 'show', '--worktree', created.id])?.worktree
      if (restored?.id !== created.id) {
        throw new Error('Restarted server cannot resolve the persisted worktree')
      }
      log('clean restart restored persisted worktree OK')
    }
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
      if (screenshot?.format !== 'png' || typeof screenshot.data !== 'string' || !screenshot.data) {
        throw new Error('browser.screenshot returned no PNG data')
      }
      log('browser navigate/evaluate/screenshot round trip OK')
    }

    const terminal = orca(pairingCode, [
      'terminal',
      'create',
      '--worktree',
      created.id,
      ...(process.platform === 'win32' ? ['--shell', 'powershell.exe'] : [])
    ])?.terminal
    if (!terminal?.handle) {
      throw new Error('terminal.create returned no handle')
    }
    log(`created ${terminal.handle}`)

    // Assemble the nonce inside the process so terminal input echo cannot satisfy the assertion.
    const suffix = randomBytes(8).toString('hex')
    const nonce = `ORCA_SMOKE_${suffix}`
    orca(pairingCode, [
      'terminal',
      'send',
      '--terminal',
      terminal.handle,
      '--text',
      `${process.platform === 'win32' ? '& ' : ''}"${process.execPath}" -e "console.log('ORCA_SMOKE_'+'${suffix}')"`,
      '--enter'
    ])

    if (!(await waitForNonce(pairingCode, terminal.handle, nonce))) {
      throw new Error(
        `terminal produced no output containing ${nonce} within ${OUTPUT_TIMEOUT_MS}ms — ` +
          `the server started and answered RPC, but its PTY path is dead`
      )
    }
    log('terminal round trip OK')
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
    log(
      `shutdown state: launcher=${child.exitCode ?? child.signalCode ?? 'running'}, serverPid=${servingPid}, server=${runtimeServeSmokeProcessState(servingPid)}, metadataPresent=${readRuntimeServeSmokePid(userDataDir) !== null}`
    )
    if (launch.verifyFinalExport && folderWorkspace && seeded?.worktreeId) {
      try {
        verifyRuntimeServeSmokeFinalExport(userDataDir, seeded.worktreeId)
        log('shutdown diagnostic: final profile export contains the workspace')
      } catch (error) {
        log(
          `shutdown diagnostic: final profile export failed (${error.code ?? error.name}): ${error.message}`
        )
      }
    }
  } finally {
    // Why before SIGTERM: worktree removal is a server operation, so it needs the server.
    if (seeded?.worktreeId && pairing) {
      const cleanupCli = resolveCli()
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
      // Why the parent too: `worktree rm` removes the worktree directory, leaving the
      // empty `<workspaces>/<repo-name>/` container behind. Every run would leak one.
      const worktreePath = seeded.worktreeId.split('::')[1]
      if (removed.status === 0 && worktreePath && !folderWorkspace) {
        rmSync(dirname(worktreePath), {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 200
        })
      }
      if (folderWorkspace && !existsSync(join(seeded.repoPath, 'keep.txt'))) {
        fail('Removing the folder workspace deleted user-owned files')
      }
      if (removed.status !== 0) {
        log(
          `WARN: could not remove seeded worktree ${seeded.worktreeId}: ` +
            `${(removed.stderr?.trim() || removed.stdout?.trim() || '').replace(/\s+/g, ' ')} (exit ${removed.status})`
        )
      }
    }
    try {
      await stopServer(child, launch.lockPath, launch.ownerLoss, servingPid)
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error))
    }
    if (launch.ownerLoss && runtimeServeSmokeProcessState(servingPid) === 'exited') {
      const cleanupEntry = join(userDataDir, 'smoke-daemon-cleanup.cjs')
      await build({
        entryPoints: [join(projectDir, 'config/scripts/runtime-serve-smoke-daemon.ts')],
        outfile: cleanupEntry,
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node24'
      })
      const cleaned = spawnSync(process.execPath, [cleanupEntry, userDataDir], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 15_000,
        env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' }
      })
      if (cleaned.status !== 0) {
        fail(
          `Disposable daemon cleanup failed: ${cleaned.stderr || cleaned.error || cleaned.status}`
        )
      }
      child.stdout.destroy()
      child.stderr.destroy()
    }
    if (process.exitCode) {
      for (const output of diagnostics) {
        const stdout = output.stdout
          .split('\n')
          .filter((line) => !line.includes('orca_server_ready'))
          .join('\n')
        process.stderr.write(
          `[serve-terminal-smoke] server diagnostics:\n${stdout}\n${output.stderr}\n`
        )
      }
    }
    try {
      launch.dispose?.()
    } catch (error) {
      fail(error.message)
    }
    rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    if (seeded?.repoPath) {
      rmSync(seeded.repoPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
  }

  if (!process.exitCode) {
    log('PASS')
  }
}

await main()
