import {
  getProcessOutputFields,
  iterateProcessOutputLines
} from '../../shared/process-output-field-scanner'
import type { SshConnection } from './ssh-connection'
import { powerShellCommand } from './ssh-remote-powershell'
import type { SshRelayWindowsHostEvidence } from './ssh-relay-artifact-selector'
import { execCommand } from './ssh-relay-deploy-helpers'

export type SshRelayWindowsCompatibilityEvidence = Required<
  Pick<
    SshRelayWindowsHostEvidence,
    'build' | 'openSshVersion' | 'powerShellVersion' | 'dotNetFrameworkRelease'
  >
>

type EvidenceField = keyof SshRelayWindowsCompatibilityEvidence
type ProbeMarker = 'BEGIN' | 'END'

const PROBE_MARKER = '__ORCA_SSH_RELAY_WINDOWS_COMPATIBILITY__'
const PROBE_TIMEOUT_MS = 15_000
const MAX_FIELD_LINE_CHARS = 128
const EXPECTED_FIELD_COUNT = 4

// Why: registry values must come from the OS view that owns Windows compatibility contracts,
// independent of the architecture of the PowerShell process launched by sshd.
const PROBE_SCRIPT = [
  "$build = ''",
  "$openSshVersion = ''",
  "$powerShellVersion = ''",
  "$dotNetFrameworkRelease = ''",
  'try {',
  '  $baseKey = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryView]::Registry64)',
  '  try {',
  "    $currentVersionKey = $baseKey.OpenSubKey('SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion')",
  '    if ($null -ne $currentVersionKey) {',
  '      try {',
  "        $candidate = [string]$currentVersionKey.GetValue('CurrentBuildNumber')",
  "        if ($candidate -match '^[1-9][0-9]{0,15}$') { $build = $candidate }",
  '      } finally { $currentVersionKey.Dispose() }',
  '    }',
  "    $frameworkKey = $baseKey.OpenSubKey('SOFTWARE\\Microsoft\\NET Framework Setup\\NDP\\v4\\Full')",
  '    if ($null -ne $frameworkKey) {',
  '      try {',
  "        $candidate = [string]$frameworkKey.GetValue('Release')",
  "        if ($candidate -match '^[1-9][0-9]{0,15}$') { $dotNetFrameworkRelease = $candidate }",
  '      } finally { $frameworkKey.Dispose() }',
  '    }',
  '  } finally { $baseKey.Dispose() }',
  '} catch {}',
  'try {',
  '  $candidate = [string]$PSVersionTable.PSVersion',
  "  if ($candidate -match '^[0-9]{1,10}(?:\\.[0-9]{1,10}){1,3}$') { $powerShellVersion = $candidate }",
  '} catch {}',
  'try {',
  "  $sshd = Get-Command -Name 'sshd.exe' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1",
  '  if ($null -ne $sshd -and $sshd.Source) {',
  '    $sshdPath = [string]$sshd.Source',
  '    $versionOutput = & $sshdPath -V 2>&1 | Select-Object -First 8 | Out-String',
  '    if ($versionOutput.Length -le 4096) {',
  "      $matches = [regex]::Matches($versionOutput, '(?:^|[^0-9A-Za-z])OpenSSH_for_Windows_([0-9]{1,10}\\.[0-9]{1,10}p[0-9]{1,10})(?:[^0-9A-Za-z]|$)')",
  '      if ($matches.Count -eq 1) { $openSshVersion = $matches[0].Groups[1].Value }',
  '    }',
  '  }',
  '} catch {}',
  // Why: emit only normalized bounded fields; native and registry command output is never relayed.
  `Write-Output ("\`n${PROBE_MARKER} BEGIN")`,
  "Write-Output ('build=' + $build)",
  "Write-Output ('openSshVersion=' + $openSshVersion)",
  "Write-Output ('powerShellVersion=' + $powerShellVersion)",
  "Write-Output ('dotNetFrameworkRelease=' + $dotNetFrameworkRelease)",
  `Write-Output '${PROBE_MARKER} END'`
].join('\n')

function parseMarker(line: string): ProbeMarker | null {
  const fields = getProcessOutputFields(line, 3)
  if (fields.length !== 2 || fields[0] !== PROBE_MARKER) {
    return null
  }
  return fields[1] === 'BEGIN' || fields[1] === 'END' ? fields[1] : null
}

function parsePositiveSafeInteger(value: string): number | null {
  if (!/^[1-9]\d{0,15}$/u.test(value)) {
    return null
  }
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

function parseNumericVersion(value: string, pattern: RegExp): string | null {
  if (!pattern.test(value)) {
    return null
  }
  return value.split(/[.p]/u).every((part) => Number.isSafeInteger(Number(part))) ? value : null
}

function parseField(line: string): { field: EvidenceField; value: string | number } | undefined {
  const match = /^(build|openSshVersion|powerShellVersion|dotNetFrameworkRelease)=(.*)$/u.exec(line)
  if (!match) {
    return undefined
  }
  const field = match[1] as EvidenceField
  const rawValue = match[2]
  switch (field) {
    case 'build':
    case 'dotNetFrameworkRelease': {
      const value = parsePositiveSafeInteger(rawValue)
      return value === null ? undefined : { field, value }
    }
    case 'openSshVersion': {
      const value = parseNumericVersion(rawValue, /^\d+\.\d+p\d+$/u)
      return value === null ? undefined : { field, value }
    }
    case 'powerShellVersion': {
      const value = parseNumericVersion(rawValue, /^\d+(?:\.\d+){1,3}$/u)
      return value === null ? undefined : { field, value }
    }
  }
}

function parseWindowsCompatibilityEvidence(
  output: string
): SshRelayWindowsCompatibilityEvidence | undefined {
  let active = false
  let complete = false
  let fieldCount = 0
  let invalid = false
  const evidence: Partial<SshRelayWindowsCompatibilityEvidence> = {}

  for (const line of iterateProcessOutputLines(output)) {
    const marker = parseMarker(line)
    if (marker === 'BEGIN') {
      if (active || complete) {
        invalid = true
      }
      active = true
      continue
    }
    if (marker === 'END') {
      if (!active || complete) {
        invalid = true
      }
      active = false
      complete = true
      continue
    }
    if (!active) {
      continue
    }
    fieldCount += 1
    if (line.length > MAX_FIELD_LINE_CHARS || fieldCount > EXPECTED_FIELD_COUNT) {
      invalid = true
      continue
    }
    const parsed = parseField(line)
    if (!parsed || evidence[parsed.field] !== undefined) {
      invalid = true
      continue
    }
    Object.assign(evidence, { [parsed.field]: parsed.value })
  }

  if (
    invalid ||
    active ||
    !complete ||
    fieldCount !== EXPECTED_FIELD_COUNT ||
    evidence.build === undefined ||
    evidence.openSshVersion === undefined ||
    evidence.powerShellVersion === undefined ||
    evidence.dotNetFrameworkRelease === undefined
  ) {
    return undefined
  }
  return evidence as SshRelayWindowsCompatibilityEvidence
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

export async function detectSshRelayWindowsCompatibility(
  conn: SshConnection,
  { signal }: { signal?: AbortSignal } = {}
): Promise<SshRelayWindowsCompatibilityEvidence | undefined> {
  try {
    const output = await execCommand(conn, powerShellCommand(PROBE_SCRIPT), {
      signal,
      timeoutMs: PROBE_TIMEOUT_MS,
      wrapCommand: false
    })
    return parseWindowsCompatibilityEvidence(output)
  } catch (error) {
    // Why: cancellation must settle bootstrap work rather than becoming compatibility evidence.
    if (isAbortError(error)) {
      throw error
    }
    return undefined
  }
}
