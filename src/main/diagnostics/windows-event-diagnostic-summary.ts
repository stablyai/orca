import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { redactString } from '../observability/redactor'

const execFileAsync = promisify(execFile)
const MAX_EVENTS = 20
const EVENT_TIMEOUT_MS = 5_000

type WindowsEventRow = {
  TimeCreated?: string
  ProviderName?: string
  Id?: number
  LevelDisplayName?: string
  Message?: string
}

export async function collectWindowsEventDiagnosticSummary(
  lookbackMinutes: number
): Promise<Record<string, unknown>> {
  if (process.platform !== 'win32') {
    return { supported: false, reason: 'not_windows' }
  }
  const boundedLookbackMinutes = Math.max(1, Math.floor(lookbackMinutes))
  const command = [
    `$start=(Get-Date).AddMinutes(-${boundedLookbackMinutes});`,
    `try {`,
    `$events=@(Get-WinEvent -FilterHashtable @{LogName='Application'; StartTime=$start} -ErrorAction Stop |`,
    `Where-Object { $_.ProviderName -match 'Application Error|Application Hang|Windows Error Reporting' -or $_.Message -match 'Orca|Orca.exe|Electron' } |`,
    `Select-Object -First ${MAX_EVENTS} TimeCreated,ProviderName,Id,LevelDisplayName,Message);`,
    `$events | ConvertTo-Json -Compress`,
    `} catch {`,
    `if ($_.FullyQualifiedErrorId -eq 'NoMatchingEventsFound,Microsoft.PowerShell.Commands.GetWinEventCommand') { '[]' } else { throw }`,
    `}`
  ].join(' ')
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', command], {
    timeout: EVENT_TIMEOUT_MS,
    maxBuffer: 1024 * 1024
  })
  const parsed = parseWindowsEventJson(stdout)
  return {
    supported: true,
    count: parsed.length,
    events: parsed.map((event) => ({
      timeCreated: event.TimeCreated,
      providerName: event.ProviderName,
      id: event.Id,
      level: event.LevelDisplayName,
      messagePreview: event.Message ? redactString(event.Message).slice(0, 500) : undefined
    }))
  }
}

function parseWindowsEventJson(stdout: string): WindowsEventRow[] {
  const trimmed = stdout.trim()
  if (!trimmed) {
    return []
  }
  const parsed = JSON.parse(trimmed) as WindowsEventRow | WindowsEventRow[] | null
  if (!parsed) {
    return []
  }
  return Array.isArray(parsed) ? parsed : [parsed]
}
