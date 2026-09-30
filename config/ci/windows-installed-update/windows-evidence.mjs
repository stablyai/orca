// Process and filesystem evidence for the Windows installed-lifecycle diagnostic.
// Verdicts use the execution-boundary vocabulary: live / unverifiable / exited.
import { join, win32 } from 'node:path'

const GENERATION = /^bun-[a-f0-9]{64}(?:\.repair-[1-9][0-9]*)?$/u

export function powershellPath(env = process.env) {
  return win32.join(
    env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  )
}

// A pwsh 7 step exports PSModulePath with pwsh 7 module dirs; 5.1 then autoloads those
// incompatible modules and Get-AuthenticodeSignature returns nothing. Unset, 5.1 uses its defaults.
export function windowsPowerShellEnv(env = process.env) {
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => name.toUpperCase() !== 'PSMODULEPATH')
  )
}

export function windowsPowerShellSpec(script, env = process.env, timeoutMs = 60_000) {
  return {
    program: powershellPath(env),
    args: ['-NoProfile', '-NonInteractive', '-Command', script],
    env: windowsPowerShellEnv(env),
    timeoutMs
  }
}

export function authenticodeScript(path) {
  const literal = path.replaceAll("'", "''")
  return [
    "$ErrorActionPreference='Stop'",
    `$s=Get-AuthenticodeSignature -LiteralPath '${literal}'`,
    "if(-not $s){throw 'Get-AuthenticodeSignature returned no result'}",
    'ConvertTo-Json -Compress -InputObject @{status=[string]$s.Status;subject=[string]$s.SignerCertificate.Subject;issuer=[string]$s.SignerCertificate.Issuer;thumbprint=[string]$s.SignerCertificate.Thumbprint;timestamped=[bool]$s.TimeStamperCertificate}'
  ].join('\n')
}

/** Throws on an empty or statusless answer so a module-load failure never reads as a verdict. */
export function parseAuthenticode(stdout) {
  const text = stdout.trim()
  if (!text) {
    throw new Error('Authenticode query printed nothing')
  }
  const signer = JSON.parse(text)
  if (typeof signer?.status !== 'string' || !signer.status) {
    throw new Error(`Authenticode query returned no status: ${text}`)
  }
  return signer
}

// One CIM snapshot; @() keeps a single row an array under PowerShell 5.1.
export const PROCESS_TABLE_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  '$rows=@(Get-CimInstance Win32_Process | ForEach-Object {',
  "  [pscustomobject]@{pid=[int]$_.ProcessId;ppid=[int]$_.ParentProcessId;name=[string]$_.Name;exe=[string]$_.ExecutablePath;command=[string]$_.CommandLine;created=$(if($_.CreationDate){$_.CreationDate.ToUniversalTime().ToString('o')}else{''})}",
  '})',
  'ConvertTo-Json -InputObject @{rows=$rows} -Depth 3 -Compress'
].join('\n')

/** Returns null when the snapshot is incomplete; callers must treat that as unverifiable. */
export function parseProcessTable(stdout) {
  let parsed
  try {
    parsed = JSON.parse(stdout.trim())
  } catch {
    return null
  }
  const rows = parsed?.rows
  if (!Array.isArray(rows) || rows.length === 0) {
    return null
  }
  const result = []
  for (const row of rows) {
    if (!Number.isSafeInteger(row?.pid) || typeof row.name !== 'string') {
      return null
    }
    result.push({
      pid: row.pid,
      ppid: Number.isSafeInteger(row.ppid) ? row.ppid : null,
      name: row.name,
      exe: typeof row.exe === 'string' && row.exe ? row.exe : null,
      command: typeof row.command === 'string' && row.command ? row.command : null,
      created: typeof row.created === 'string' && row.created ? row.created : null
    })
  }
  return result
}

/** Identity is pid plus creation time; a reused pid is a different process. */
export function processIdentity(table, pid) {
  if (!table) {
    return null
  }
  const row = table.find((candidate) => candidate.pid === pid)
  return row?.created ? { pid, created: row.created, exe: row.exe, command: row.command } : null
}

export function processVerdict(table, identity) {
  if (!table || !identity?.created) {
    return 'unverifiable'
  }
  const row = table.find((candidate) => candidate.pid === identity.pid)
  if (!row) {
    return 'exited'
  }
  if (!row.created) {
    return 'unverifiable'
  }
  return row.created === identity.created ? 'live' : 'exited'
}

function normalized(path) {
  return path.replaceAll('/', '\\').replace(/\\+$/u, '').toLowerCase()
}

export function isUnder(path, root) {
  return typeof path === 'string' && normalized(path).startsWith(`${normalized(root)}\\`)
}

/** Generation directory that owns a runtime image, or null when outside the managed namespace. */
export function generationOfImage(exe, managedRoot) {
  if (!isUnder(exe, managedRoot)) {
    return null
  }
  const [directory, file, ...rest] = normalized(exe)
    .slice(normalized(managedRoot).length + 1)
    .split('\\')
  return rest.length === 0 && file === 'bun-runtime.exe' && GENERATION.test(directory)
    ? directory
    : null
}

export function isGenerationName(name) {
  return GENERATION.test(name)
}

/** Every live process whose image is inside one of the given roots. */
export function processesUnder(table, roots) {
  return table.filter((row) => row.exe && roots.some((root) => isUnder(row.exe, root)))
}

export function managedRootFor(localAppData) {
  return join(localAppData, 'Orca', 'terminal-daemon-host', 'managed-v1')
}

// Decodes a PowerShell -EncodedCommand so the receipt names which script a shell runs.
export function encodedPowerShell(command) {
  const encoded = /-EncodedCommand\s+([A-Za-z0-9+/=]+)/u.exec(command ?? '')?.[1]
  return encoded ? Buffer.from(encoded, 'base64').toString('utf16le').slice(0, 1500) : undefined
}
export function descendantsOf(table, pid) {
  const found = []
  const frontier = [pid]
  while (frontier.length > 0) {
    const parent = frontier.pop()
    for (const row of table) {
      if (row.ppid === parent && !found.some((seen) => seen.pid === row.pid)) {
        found.push(row)
        frontier.push(row.pid)
      }
    }
  }
  return found.map((row) => ({
    pid: row.pid,
    ppid: row.ppid,
    name: row.name,
    created: row.created,
    command: row.command?.slice(0, 300),
    script: encodedPowerShell(row.command)
  }))
}
export const ptyHostCount = (table, owner) =>
  table.filter((row) => row.ppid === owner.pid && /^bun-runtime\.exe$/iu.test(row.name)).length

/** An Electron-hosted daemon runs the relocated Orca.exe copy with that copy's daemon-entry.js. */
export function isRelocatedElectronDaemon(row, hostDir) {
  const image = `${normalized(hostDir)}\\orca.exe`
  const command = row?.command ? normalized(row.command) : ''
  return (
    Boolean(row?.exe) &&
    normalized(row.exe) === image &&
    command.includes(`${normalized(hostDir)}\\`) &&
    /daemon-entry\.js/u.test(command)
  )
}
