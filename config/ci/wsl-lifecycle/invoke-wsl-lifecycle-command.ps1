. (Join-Path $PSScriptRoot '../windows-lifecycle-receipt.ps1')
$script:wslLifecycleReports=@{}

function Save-WslLifecycleReceipt([hashtable]$Report,[string]$Receipt) {
  if([Text.Encoding]::UTF8.GetByteCount(($Report | ConvertTo-Json -Depth 6)) -gt 16384 -or -not (Write-WindowsLifecycleReceipt $Report $Receipt)){
    Write-Warning 'WSL lifecycle receipt unavailable; preserve native command and cleanup behavior'
  }
}

function Invoke-WslLifecycleCommand {
  param(
    [Parameter(Mandatory=$true)][string]$Receipt,
    [Parameter(Mandatory=$true)][ValidatePattern('^[a-z][a-z0-9-]{0,63}$')][string]$Stage,
    [ValidateLength(0,128)][string]$Distro='',
    [Parameter(Mandatory=$true)][string[]]$Arguments
  )
  if(-not $script:wslLifecycleReports.ContainsKey($Receipt)){
    $script:wslLifecycleReports[$Receipt]=@{version=1;sourceSha=$env:GITHUB_SHA;runId=$env:GITHUB_RUN_ID;runAttempt=$env:GITHUB_RUN_ATTEMPT;imageVersion=$env:ImageVersion;operations=@()}
  }
  $report=$script:wslLifecycleReports[$Receipt]
  $operation=@{stage=$Stage;distro=$Distro;status='running';startedAt=[DateTime]::UtcNow.ToString('o');elapsedMs=0;exitCode=$null}
  if($report.operations.Count -lt 32){$report.operations+=@($operation)}else{$report.truncated=$true}
  Save-WslLifecycleReceipt $report $Receipt
  Write-Host "WSL lifecycle: $Stage $Distro started"
  $watch=[Diagnostics.Stopwatch]::StartNew()
  try {
    & wsl.exe @Arguments
    $operation.exitCode=$LASTEXITCODE
    if($LASTEXITCODE -ne 0){throw "WSL lifecycle $Stage failed for $Distro with exit $LASTEXITCODE"}
    $operation.status='passed'
  } catch {
    $operation.status='failed'
    throw
  } finally {
    $watch.Stop();$operation.elapsedMs=$watch.ElapsedMilliseconds;$operation.finishedAt=[DateTime]::UtcNow.ToString('o')
    Save-WslLifecycleReceipt $report $Receipt
    Write-Host "WSL lifecycle: $Stage $Distro $($operation.status) $($operation.elapsedMs)ms"
  }
}
