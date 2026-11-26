param(
  [Parameter(Mandatory = $true)][string]$Bot,
  [Parameter(Mandatory = $true)][string]$Output
)
$ErrorActionPreference = 'Stop'
$marker = 'automation-access-probe-' + [guid]::NewGuid().ToString('N')
$plan = [ordered]@{
  marker = $marker
  executes = $false
  prerequisites = @('Corrected host deployed', 'Policy enabled', 'Dedicated test bot/chat', 'Confirm new chat and thread IDs')
  triggerOptions = @('automations', 'trigger-options', '--bot', $Bot, '--json')
  create = @('automations', 'create', '--name', $marker, '--bot', $Bot, '--agent', 'codex',
    '--trigger', 'daily', '--time', '23:59', '--disabled', '--runs-in', 'new', '--results-to', 'none',
    '--prompt', "Permission probe $marker. Respond only with this marker. Do not call tools, access business data, contact anyone, or make changes.", '--json')
  run = @('automations', 'run', '--id', '<new-probe-automation-id>', '--json')
  evidence = @('automation ID', 'run ID', 'new chat ID', 'new Codex thread ID', 'thread_settings_applied from that thread')
}
$stream = [System.IO.File]::Open($Output, [System.IO.FileMode]::CreateNew)
try {
  $bytes = [System.Text.Encoding]::UTF8.GetBytes(($plan | ConvertTo-Json -Depth 5))
  $stream.Write($bytes, 0, $bytes.Length)
} finally { $stream.Dispose() }
Write-Output "Prepared only: $Output ($marker)"
