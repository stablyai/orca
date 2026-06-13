import { execFile } from 'child_process'
import { promisify } from 'util'
import { encodePowerShellCommand } from '../shared/powershell-command-encoding'
import type { DetectedPort } from './port-scan-handler'
import { buildRelayCommandEnv } from './relay-command-env'

const SYSTEM_PORTS_TO_EXCLUDE = new Set([22])
const MAX_DETECTED_PORTS = 50
const WINDOWS_PORT_SCAN_TIMEOUT_MS = 5_000
const execFileAsync = promisify(execFile)

export async function scanWindowsListeningPorts(signal?: AbortSignal): Promise<DetectedPort[]> {
  try {
    const json = await runWindowsPortScanPowerShell(signal)
    return normalizeWindowsDetectedPorts(parseWindowsPowerShellPortRows(json))
  } catch {
    if (signal?.aborted) {
      return []
    }
    try {
      const { stdout } = await execFileAsync('netstat.exe', ['-ano', '-p', 'tcp'], {
        env: buildRelayCommandEnv(),
        encoding: 'utf-8',
        signal,
        timeout: WINDOWS_PORT_SCAN_TIMEOUT_MS,
        windowsHide: true
      })
      return normalizeWindowsDetectedPorts(parseWindowsNetstatOutput(stdout))
    } catch {
      return []
    }
  }
}

async function runWindowsPortScanPowerShell(signal?: AbortSignal): Promise<string> {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$connections = Get-NetTCPConnection -State Listen -ErrorAction Stop',
    '$items = foreach ($connection in $connections) {',
    '  $name = $null',
    '  try {',
    '    $process = Get-Process -Id $connection.OwningProcess -ErrorAction Stop',
    '    $name = $process.ProcessName',
    '  } catch {}',
    '  [pscustomobject]@{',
    '    host = [string]$connection.LocalAddress',
    '    port = [int]$connection.LocalPort',
    '    pid = [int]$connection.OwningProcess',
    '    processName = $name',
    '  }',
    '}',
    '$items | ConvertTo-Json -Compress -Depth 3'
  ].join('\n')
  const encoded = encodePowerShellCommand(script)
  const lastError: unknown[] = []

  for (const binary of ['powershell.exe', 'pwsh.exe']) {
    try {
      const { stdout } = await execFileAsync(
        binary,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
        {
          env: buildRelayCommandEnv(),
          encoding: 'utf-8',
          maxBuffer: 1024 * 1024,
          signal,
          timeout: WINDOWS_PORT_SCAN_TIMEOUT_MS,
          windowsHide: true
        }
      )
      return stdout
    } catch (error) {
      if (signal?.aborted) {
        throw error
      }
      lastError.push(error)
    }
  }

  throw lastError[0] ?? new Error('PowerShell unavailable')
}

export function parseWindowsPowerShellPortRows(json: string): DetectedPort[] {
  const trimmed = json.trim()
  if (!trimmed) {
    return []
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return []
  }

  const rows = Array.isArray(parsed) ? parsed : [parsed]
  return rows.flatMap((row) => parseWindowsPortRow(row))
}

export function parseWindowsNetstatOutput(output: string): DetectedPort[] {
  const rows: DetectedPort[] = []

  for (const line of output.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/)
    if (fields.length < 5 || fields[0].toUpperCase() !== 'TCP') {
      continue
    }
    if (fields[3].toUpperCase() !== 'LISTENING') {
      continue
    }
    const hostPort = parseWindowsNetstatAddress(fields[1])
    const pid = Number.parseInt(fields[4], 10)
    if (!hostPort || !Number.isSafeInteger(pid) || pid <= 0) {
      continue
    }
    rows.push({ ...hostPort, pid })
  }

  return rows
}

function parseWindowsPortRow(row: unknown): DetectedPort[] {
  if (!row || typeof row !== 'object') {
    return []
  }
  const value = row as {
    host?: unknown
    LocalAddress?: unknown
    port?: unknown
    LocalPort?: unknown
    pid?: unknown
    OwningProcess?: unknown
    processName?: unknown
    ProcessName?: unknown
  }
  const host = readString(value.host ?? value.LocalAddress)
  const port = readInteger(value.port ?? value.LocalPort)
  const pid = readInteger(value.pid ?? value.OwningProcess)
  const processName = readString(value.processName ?? value.ProcessName)
  if (!host || port == null || pid == null) {
    return []
  }
  return [
    {
      host,
      port,
      pid,
      ...(processName ? { processName } : {})
    }
  ]
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function readInteger(value: unknown): number | undefined {
  const parsed =
    typeof value === 'number' ? value : typeof value === 'string' ? Number.parseInt(value, 10) : NaN
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

function parseWindowsNetstatAddress(value: string): { host: string; port: number } | null {
  const ipv6Match = /^\[(.*)\]:(\d+)$/.exec(value)
  const portText = ipv6Match?.[2] ?? value.slice(value.lastIndexOf(':') + 1)
  const port = Number.parseInt(portText, 10)
  if (!Number.isSafeInteger(port) || port <= 0) {
    return null
  }
  if (ipv6Match) {
    return { host: ipv6Match[1], port }
  }
  const idx = value.lastIndexOf(':')
  if (idx <= 0) {
    return null
  }
  return { host: value.slice(0, idx), port }
}

function normalizeWindowsDetectedPorts(ports: DetectedPort[]): DetectedPort[] {
  const seen = new Set<string>()
  const relayPid = process.pid
  const relayParentPid = process.ppid
  const normalized: DetectedPort[] = []

  for (const port of ports) {
    const processName = port.processName?.toLowerCase()
    const key = `${port.host}:${port.port}:${port.pid ?? ''}`
    if (
      seen.has(key) ||
      SYSTEM_PORTS_TO_EXCLUDE.has(port.port) ||
      port.pid === relayPid ||
      port.pid === relayParentPid ||
      processName === 'sshd'
    ) {
      continue
    }
    seen.add(key)
    normalized.push(port)
  }

  normalized.sort((a, b) => a.port - b.port || a.host.localeCompare(b.host))
  return normalized.slice(0, MAX_DETECTED_PORTS)
}
