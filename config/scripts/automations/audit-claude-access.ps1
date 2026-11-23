param(
  [Parameter(Mandatory = $true)][string]$WireTranscript,
  [Parameter(Mandatory = $true)][string]$ExpectedSession
)
$ErrorActionPreference = 'Stop'
$frames = @(Get-Content -LiteralPath $WireTranscript | ForEach-Object {
  $frame = $_ | ConvertFrom-Json
  if ($frame.type -eq 'system' -and $frame.subtype -in @('init', 'status') -and $null -ne $frame.permissionMode) {
    [pscustomobject]@{ kind = $frame.subtype; session = $frame.session_id; mode = $frame.permissionMode }
  }
})
$frames | ConvertTo-Json -Depth 3
$init = @($frames | Where-Object { $_.kind -eq 'init' })
if (!$init.Count -or @($init | Where-Object { $_.session -ne $ExpectedSession }).Count -or
    @($frames | Where-Object { $_.mode -ne 'bypassPermissions' }).Count -or
    @($frames | Where-Object { $_.session -and $_.session -ne $ExpectedSession }).Count) {
  throw 'Claude Full Access at initialization is unproven or contradicted'
}
