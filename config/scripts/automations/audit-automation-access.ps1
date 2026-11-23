param(
  [string]$Orca = 'orca',
  [string]$Transcript,
  [string]$ExpectedThread,
  [switch]$RequireFullAccess
)
$ErrorActionPreference = 'Stop'
$response = (& $Orca automations list --json | Out-String) | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or -not $response.ok) { throw 'Cannot inventory automations' }
$inventory = @($response.result.automations | ForEach-Object {
  [ordered]@{
    id = $_.id; name = $_.name; enabled = $_.enabled; agent = $_.agentId
    botId = $_.bot.botId; runsIn = $_.bot.runsIn; reuseSession = $_.reuseSession
    timezone = $_.timezone; schedule = $_.rrule
  }
})
$events = @()
if ($Transcript) {
  $events = @(Get-Content -LiteralPath $Transcript | ForEach-Object {
    $row = $_ | ConvertFrom-Json
    if ($row.payload.type -eq 'thread_settings_applied') {
      $settings = $row.payload.thread_settings
      [ordered]@{
        at = $row.timestamp; thread = $row.payload.thread_id
        approval = $settings.approval_policy
        profile = $settings.active_permission_profile.id
        permissionType = $settings.permission_profile.type
        filesystem = $settings.permission_profile.file_system.type
        network = $settings.permission_profile.network
        fullAccess = ($settings.approval_policy -eq 'never' -and
          ($settings.permission_profile.type -eq 'disabled' -or
            ($settings.permission_profile.file_system.type -eq 'unrestricted' -and
             $settings.permission_profile.network -eq 'enabled')))
      }
    }
  })
}
[ordered]@{ automations = $inventory; permissionEvents = $events } | ConvertTo-Json -Depth 6
if ($ExpectedThread -and (!$events.Count -or @($events | Where-Object { $_.thread -ne $ExpectedThread }).Count)) {
  throw 'Transcript does not prove the expected new thread'
}
if ($RequireFullAccess -and (!$ExpectedThread -or !$events.Count -or @($events | Where-Object { !$_.fullAccess }).Count)) {
  throw 'Full Access at thread start is unproven or contradicted'
}
