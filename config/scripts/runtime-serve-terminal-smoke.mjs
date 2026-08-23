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
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import process from 'node:process'

const projectDir = resolve(import.meta.dirname, '../..')
const serveEntry = join(projectDir, 'out', 'main', 'index.js')
const READY_TIMEOUT_MS = 120_000
const OUTPUT_TIMEOUT_MS = 30_000
const SHUTDOWN_TIMEOUT_MS = 15_000
// Why a random high port: a fixed one collides with a developer's own `orca serve`.
const PORT = 6800 + Math.floor(Number(process.env.ORCA_SMOKE_PORT_OFFSET ?? '0'))

function log(message) {
  process.stdout.write(`[serve-terminal-smoke] ${message}\n`)
}

function fail(message) {
  process.stderr.write(`[serve-terminal-smoke] FAIL: ${message}\n`)
  process.exitCode = 1
}

/** The `orca` CLI, driven with an explicit pairing code so it targets this server only. */
function orca(pairingCode, args) {
  const result = spawnSync('orca', [...args, '--pairing-code', pairingCode, '--json'], {
    encoding: 'utf8',
    // Why not shell:true — argument encoding is handled by spawnSync; a shell would
    // re-split the pairing code, which is base64url and can contain '='.
    shell: false
  })
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
    const timer = setTimeout(
      () => rejectPromise(new Error(`no ready payload within ${READY_TIMEOUT_MS}ms`)),
      READY_TIMEOUT_MS
    )
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
      rejectPromise(new Error(`server exited with ${code} before signalling ready`))
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

async function main() {
  const userDataDir = mkdtempSync(join(tmpdir(), 'orca-serve-smoke-'))
  log(`booting ${serveEntry} on port ${PORT} with userData ${userDataDir}`)

  const child = spawn(
    process.env.ORCA_SMOKE_ELECTRON ?? 'npx',
    process.env.ORCA_SMOKE_ELECTRON
      ? [
          serveEntry,
          '--serve',
          '--serve-port',
          String(PORT),
          '--serve-json',
          `--user-data-dir=${userDataDir}`
        ]
      : [
          'electron',
          serveEntry,
          '--serve',
          '--serve-port',
          String(PORT),
          '--serve-json',
          `--user-data-dir=${userDataDir}`
        ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  )

  try {
    const ready = await waitForReady(child)
    log(`ready: ${ready.advertisedEndpoint}`)
    const pairingCode = pairingCodeFrom(ready)

    const worktrees = orca(pairingCode, ['worktree', 'list'])?.worktrees ?? []
    if (worktrees.length === 0) {
      throw new Error('paired client saw no worktrees; cannot create a terminal')
    }
    log(`paired client sees ${worktrees.length} worktree(s)`)

    const terminal = orca(pairingCode, [
      'terminal',
      'create',
      '--worktree',
      worktrees[0].id
    ])?.terminal
    if (!terminal?.handle) {
      throw new Error('terminal.create returned no handle')
    }
    log(`created ${terminal.handle}`)

    // Why invoke node rather than `echo`: the shell differs per platform, node does not.
    const nonce = `ORCA_SMOKE_${randomBytes(8).toString('hex')}`
    orca(pairingCode, [
      'terminal',
      'send',
      '--terminal',
      terminal.handle,
      '--text',
      `"${process.execPath}" -e "console.log('${nonce}')"`,
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
  } finally {
    child.kill('SIGTERM')
    const exited = await Promise.race([
      new Promise((r) => child.on('exit', () => r(true))),
      new Promise((r) => setTimeout(() => r(false), SHUTDOWN_TIMEOUT_MS))
    ])
    if (!exited) {
      child.kill('SIGKILL')
      fail(`server did not exit within ${SHUTDOWN_TIMEOUT_MS}ms of SIGTERM`)
    }
    rmSync(userDataDir, { recursive: true, force: true })
  }

  if (!process.exitCode) {
    log('PASS')
  }
}

await main()
