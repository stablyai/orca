// Host operations for the Windows installed-lifecycle diagnostic: installer, registry, serve, CLI.
// Bundled by prepare.mjs so child processes go through src/shared/child-process.
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join, win32 } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { runProcess, spawnProcess } from '../../../src/shared/child-process/run-process.ts'
import { hashIdentity } from './installed-layout.mjs'
import {
  PROCESS_TABLE_SCRIPT,
  authenticodeScript,
  parseAuthenticode,
  parseProcessTable,
  processIdentity,
  processVerdict,
  windowsPowerShellSpec
} from './windows-evidence.mjs'

export async function powershell(script, timeoutMs = 60_000) {
  return runProcess(windowsPowerShellSpec(script, process.env, timeoutMs))
}

/** A failed or partial snapshot is null: never evidence that something exited. */
export async function processTable() {
  const result = await powershell(PROCESS_TABLE_SCRIPT)
  return result.code === 0 && !result.timedOut ? parseProcessTable(result.stdout) : null
}

export async function identify(pid) {
  return processIdentity(await processTable(), pid)
}

export async function waitVerdict(identity, wanted, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  let verdict = 'unverifiable'
  while (Date.now() < deadline) {
    verdict = processVerdict(await processTable(), identity)
    if (verdict === wanted) {
      return verdict
    }
    await delay(500)
  }
  return verdict
}

const UNINSTALL_QUERY = [
  "$ErrorActionPreference='Stop'",
  "$k=@(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'Orca*' })",
  'ConvertTo-Json -Compress -InputObject @{entries=@($k | ForEach-Object { [pscustomobject]@{name=[string]$_.DisplayName;version=[string]$_.DisplayVersion;location=[string]$_.InstallLocation;quiet=[string]$_.QuietUninstallString} })}'
].join('\n')

export async function uninstallEntries() {
  const result = await powershell(UNINSTALL_QUERY)
  if (result.code !== 0) {
    throw new Error('Uninstall registry query failed')
  }
  return JSON.parse(result.stdout.trim()).entries.map((entry) => ({
    ...entry,
    location: entry.location || uninstallerDirectory(entry.quiet)
  }))
}

// Per-user NSIS installs leave InstallLocation empty; the uninstaller lives in the install root.
function uninstallerDirectory(quiet) {
  const executable = /^"([^"]+\\Uninstall [^"\\]+\.exe)"/u.exec(quiet ?? '')?.[1]
  return executable ? win32.dirname(executable) : ''
}

/** `extra` mirrors electron-updater's NsisUpdater argv; a fresh install passes none. */
// A null identity admits the first install of `receipt.version` and returns what it installed.
export async function runInstaller(installer, extra, receipt, expectedIdentity, identityFiles) {
  const args = [...extra, '/S']
  const started = Date.now()
  const result = await runProcess({ program: installer, args, timeoutMs: 600_000 })
  if (result.code !== 0 || result.timedOut) {
    throw new Error(`Installer exited ${result.code}${result.timedOut ? ' (timeout)' : ''}`)
  }
  const deadline = Date.now() + 180_000
  let last = null
  while (Date.now() < deadline) {
    const entries = await uninstallEntries()
    const entry = entries.length === 1 ? entries[0] : null
    last = { entries, executable: null, identityMismatch: null }
    if (entry?.version === receipt.version && entry.location) {
      last.executable = existsSync(join(entry.location, 'Orca.exe'))
    }
    if (last.executable) {
      const installed = await hashIdentity(entry.location, identityFiles)
      if (
        expectedIdentity === null ||
        JSON.stringify(installed) === JSON.stringify(expectedIdentity)
      ) {
        return {
          args,
          location: entry.location,
          version: entry.version,
          elapsedMs: Date.now() - started,
          identity: installed,
          identityMatched: expectedIdentity !== null
        }
      }
      last.identityMismatch = Object.keys(expectedIdentity).filter(
        (field) => installed[field] !== expectedIdentity[field]
      )
    }
    await delay(1_000)
  }
  // Keep the last observation so a mismatch names its cause instead of only timing out.
  throw new Error(
    `Installed product never matched ${receipt.label} ${receipt.version}: ${JSON.stringify(last)}`
  )
}

export async function runUninstaller() {
  const entries = await uninstallEntries()
  if (entries.length !== 1 || !entries[0].quiet) {
    throw new Error('Exactly one owned uninstall entry is required')
  }
  const match = /^"([^"]+)"\s*(.*)$/u.exec(entries[0].quiet)
  if (!match) {
    throw new Error('Unrecognized QuietUninstallString')
  }
  const args = match[2].split(/\s+/u).filter(Boolean)
  const result = await runProcess({ program: match[1], args, timeoutMs: 300_000 })
  const location = entries[0].location
  // The uninstaller relaunches a temporary copy, so completion is observed rather than awaited.
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    if ((await uninstallEntries()).length === 0 && !existsSync(join(location, 'Orca.exe'))) {
      return { args, exitCode: result.code, location }
    }
    await delay(1_000)
  }
  throw new Error('Uninstall did not complete')
}

export async function authenticode(path) {
  const result = await powershell(authenticodeScript(path))
  if (result.code !== 0 || result.timedOut) {
    throw new Error(`Authenticode query failed: ${result.stderr.trim()}`)
  }
  return parseAuthenticode(result.stdout)
}

export async function availablePort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

/** Mirrors the packaged serve-smoke environment, but keeps the real LOCALAPPDATA the installer cleans. */
export function serveEnvironment(profile, localAppData) {
  const home = join(profile, 'home')
  for (const directory of [home, join(home, 'AppData', 'Roaming')]) {
    mkdirSync(directory, { recursive: true })
  }
  const env = { ...process.env }
  for (const key of [
    'ORCA_APP_EXECUTABLE',
    'ORCA_APP_EXECUTABLE_NEEDS_APP_ROOT',
    'ELECTRON_RUN_AS_NODE',
    'NODE_OPTIONS',
    'NODE_PATH'
  ]) {
    delete env[key]
  }
  return Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: localAppData,
    ORCA_E2E_HEADLESS: '1',
    ORCA_E2E_USER_DATA_DIR: profile,
    ORCA_E2E_HOME_DIR: home,
    ORCA_USER_DATA_PATH: profile,
    ORCA_BACKGROUND_LAUNCH: '1'
  })
}

function readServingPid(profile) {
  try {
    const { pid } = JSON.parse(readFileSync(join(profile, 'orca-runtime.json'), 'utf8'))
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

export async function startServe(location, profile, env) {
  const launcher = join(location, 'resources', 'bin', 'orca.exe')
  const child = spawnProcess({
    program: launcher,
    args: ['serve', '--json', '--port', String(await availablePort())],
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let buffered = ''
  child.stderr.on('data', () => {})
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Serve readiness timeout')), 180_000)
    child.stdout.on('data', (chunk) => {
      buffered = (buffered + chunk).slice(-65_536)
      for (const line of buffered.split('\n')) {
        try {
          const data = JSON.parse(line)
          if (data.type === 'orca_server_ready') {
            clearTimeout(timer)
            resolve(data)
          }
        } catch {
          // Partial or non-JSON line.
        }
      }
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`Serve exited before readiness: ${code}`))
    })
  })
  const pairing = new URL(ready.pairing.url).searchParams.get('code')
  const servingPid = readServingPid(profile)
  const serving = servingPid ? await identify(servingPid) : null
  if (!pairing || !serving) {
    throw new Error('Serve readiness lacked pairing or a verifiable serving identity')
  }
  return { child, launcher, pairing, serving }
}

/** Launcher loss is the Windows stop path (see runtime-serve-smoke-shutdown); exit is verified by identity. */
export async function stopServe(serve) {
  if (serve.child.exitCode === null && serve.child.signalCode === null) {
    serve.child.kill()
  }
  const verdict = await waitVerdict(serve.serving, 'exited', 60_000)
  serve.child.stdout.destroy()
  serve.child.stderr.destroy()
  if (verdict !== 'exited') {
    throw new Error(`Serving process ${verdict} after stop`)
  }
  return verdict
}

// `--json` output is pretty-printed; fall back to the last line for any leading log noise.
function parseCliJson(stdout) {
  const text = stdout.trim()
  for (const candidate of [text, text.slice(text.indexOf('\n{') + 1), text.split('\n').at(-1)]) {
    try {
      return JSON.parse(candidate ?? '')
    } catch {
      // Reported by the caller without echoing output that may contain credentials.
    }
  }
  return null
}

export async function cli(serve, env, argv) {
  const result = await runProcess({
    program: serve.launcher,
    args: [...argv, '--pairing-code', serve.pairing, '--json'],
    env,
    timeoutMs: 60_000
  })
  const data = parseCliJson(result.stdout)
  if (result.code !== 0 || !data?.ok) {
    throw new Error(
      `CLI ${argv[0]} ${argv[1]} failed (${data?.error?.code ?? `exit ${result.code}`})`
    )
  }
  return data.result
}

export async function nodeTool(tool, args, env, timeoutMs = 30_000) {
  const result = await runProcess({
    program: process.execPath,
    args: [tool, ...args],
    env,
    timeoutMs
  })
  if (result.code !== 0) {
    let code = `exit ${result.code}`
    try {
      code = JSON.parse(result.stderr.trim().split('\n').at(-1)).error.code
    } catch {
      // Keep the exit code only.
    }
    throw new Error(`${args[0] ?? 'tool'} failed (${code})`)
  }
  return JSON.parse(result.stdout.trim().split('\n').at(-1))
}
