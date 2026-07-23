import { shellEscape } from './ssh-connection-utils'
import { powerShellLiteral } from './ssh-remote-powershell'

export const SSH_RELAY_MARKER_MAX_BYTES = 1024

export function powerShellReadRelayMarkerAssignment(markerPath: string): string {
  return [
    '$orcaMarkerValue = $null',
    '$orcaMarkerStream = $null',
    `try { $orcaMarkerStream = [System.IO.File]::Open(${powerShellLiteral(markerPath)}, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, ([System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete))`,
    `$orcaMarkerBuffer = New-Object byte[] ${SSH_RELAY_MARKER_MAX_BYTES + 1}`,
    '$orcaMarkerCount = $orcaMarkerStream.Read($orcaMarkerBuffer, 0, $orcaMarkerBuffer.Length)',
    `if ($orcaMarkerCount -le ${SSH_RELAY_MARKER_MAX_BYTES}) { $orcaMarkerValue = [System.Text.Encoding]::UTF8.GetString($orcaMarkerBuffer, 0, $orcaMarkerCount) }`,
    '} catch {} finally { if ($null -ne $orcaMarkerStream) { $orcaMarkerStream.Dispose() } }'
  ].join('; ')
}

export function posixReadRelayMarkerAssignment(markerPath: string): string {
  return [
    `orca_marker=$(dd if=${shellEscape(markerPath)} bs=${SSH_RELAY_MARKER_MAX_BYTES + 1} count=1 2>/dev/null) || orca_marker=`,
    `if [ "\${#orca_marker}" -gt ${SSH_RELAY_MARKER_MAX_BYTES} ]; then orca_marker=; fi`
  ].join('; ')
}
