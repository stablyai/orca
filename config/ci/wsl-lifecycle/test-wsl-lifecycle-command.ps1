$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'invoke-wsl-lifecycle-command.ps1')
$root=Join-Path ([IO.Path]::GetTempPath()) ('orca-wsl-lifecycle-'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
$script:activeReceipt=$null
$script:observedRunning=$false
$script:failStart=$false
$originalExit=$env:ORCA_WSL_LIFECYCLE_TEST_EXIT

# Replace WSL servicing only; the real native process proves argv, stdout and exit handling.
function wsl.exe {
  param([Parameter(ValueFromRemainingArguments=$true)][string[]]$NativeArguments)
  if($script:activeReceipt){
    $before=Get-Content -LiteralPath $script:activeReceipt -Raw | ConvertFrom-Json
    if($before.operations[-1].status -ne 'running' -or $before.operations[-1].exitCode -ne $null){throw 'Operation was not durable before native launch'}
    $script:observedRunning=$true
  }
  if($script:failStart){throw 'Injected launch refusal'}
  & node -e 'process.stdout.write(JSON.stringify(process.argv.slice(1)));process.exit(Number(process.env.ORCA_WSL_LIFECYCLE_TEST_EXIT||0))' -- @NativeArguments
  $global:LASTEXITCODE=$LASTEXITCODE
}

try {
  $receipt=Join-Path $root 'success.json';$script:activeReceipt=$receipt
  $arguments=@('--import','name with spaces','quote"inside','literal $HOME','line1'+"`n"+'line2','日本語')
  $output=Invoke-WslLifecycleCommand -Receipt $receipt -Stage import -Distro 'orca-lane-plain' -Arguments $arguments
  $actual=ConvertFrom-Json $output
  if(($actual | ConvertTo-Json -Compress) -ne ($arguments | ConvertTo-Json -Compress)){throw 'Native argv or stdout changed'}
  $completed=Get-Content -LiteralPath $receipt -Raw | ConvertFrom-Json
  if(-not $script:observedRunning -or $completed.version -ne 1 -or $completed.operations.Count -ne 1 -or $completed.operations[0].status -ne 'passed' -or $completed.operations[0].exitCode -ne 0 -or -not $completed.operations[0].finishedAt -or $completed.operations[0].elapsedMs -lt 0){throw 'Successful lifecycle receipt incomplete'}
  if((Get-Content -LiteralPath $receipt -Raw) -match 'literal \$HOME|NativeArguments'){throw 'Receipt exposed command arguments'}

  $receipt=Join-Path $root 'failed.json';$script:activeReceipt=$receipt;$env:ORCA_WSL_LIFECYCLE_TEST_EXIT='7'
  $failure=$null
  try {Invoke-WslLifecycleCommand -Receipt $receipt -Stage provision -Distro 'orca-lane-plain' -Arguments @('--exec','sh') | Out-Null}catch{$failure=$_}
  $failed=Get-Content -LiteralPath $receipt -Raw | ConvertFrom-Json
  if(-not $failure -or $failure.Exception.Message -notmatch 'exit 7' -or $failed.operations[0].status -ne 'failed' -or $failed.operations[0].exitCode -ne 7){throw 'Native failure was suppressed or not recorded'}

  $receipt=Join-Path $root 'launch-refused.json';$script:activeReceipt=$receipt;$script:failStart=$true
  $failure=$null
  try {Invoke-WslLifecycleCommand -Receipt $receipt -Stage terminate -Arguments @('--terminate','orca-lane-plain') | Out-Null}catch{$failure=$_}
  $refused=Get-Content -LiteralPath $receipt -Raw | ConvertFrom-Json
  if(-not $failure -or $failure.Exception.Message -ne 'Injected launch refusal' -or $refused.operations[0].status -ne 'failed' -or $refused.operations[0].exitCode -ne $null){throw 'Launch refusal was replaced or misreported'}

  $script:activeReceipt=$null;$script:failStart=$false;$env:ORCA_WSL_LIFECYCLE_TEST_EXIT='0'
  $missingParent=Join-Path $root 'absent/cleanup.json'
  $output=Invoke-WslLifecycleCommand -Receipt $missingParent -Stage terminate -Arguments @('--terminate','orca-lane-plain') -WarningAction SilentlyContinue
  if((ConvertFrom-Json $output)[0] -ne '--terminate'){throw 'Receipt failure suppressed cleanup'}

  $receipt=Join-Path $root 'bounded.json'
  foreach($iteration in 1..34){Invoke-WslLifecycleCommand -Receipt $receipt -Stage list -Arguments @('--list') | Out-Null}
  $bounded=Get-Content -LiteralPath $receipt -Raw | ConvertFrom-Json
  if($bounded.operations.Count -ne 32 -or -not $bounded.truncated -or (Get-Item -LiteralPath $receipt).Length -gt 16384){throw 'Lifecycle receipt was not bounded or truncation was hidden'}
  Write-Host 'WSL lifecycle receipt checks passed: durable starts, native argv/stdout, exit failures, launch refusal, cleanup on receipt failure, bounded metadata'
} finally {
  $env:ORCA_WSL_LIFECYCLE_TEST_EXIT=$originalExit
  Remove-Item Function:wsl.exe -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
