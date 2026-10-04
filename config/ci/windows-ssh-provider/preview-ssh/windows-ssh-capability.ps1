function Assert-IsolatedWindowsSshCi([ValidateSet('arm64','x64')][string]$Arch) {
  $os=@{arm64='Arm64';x64='X64'}[$Arch]
  if($env:GITHUB_ACTIONS -ne 'true' -or $env:ORCA_ISOLATED_SSH_CI -ne '1' -or [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString() -ne $os){throw "Requires isolated native $Arch GitHub runner"}
  $admin=([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if(-not $admin){throw 'Administrative private service/account setup required'}
}

function Assert-WindowsSshGlobalServerDormant([ValidateSet('preview','inbox')][string]$Server) {
  $global=Get-CimInstance Win32_Service -Filter "Name='sshd'"
  if(-not $global){return}
  $inboxDir=Join-Path $env:WINDIR 'System32\OpenSSH'
  # Inbox installation may register the global service; it must never be started here.
  if($Server -ne 'inbox' -or $global.State -ne 'Stopped' -or $global.PathName.Trim('"') -ne (Join-Path $inboxDir 'sshd.exe')){throw 'Refuse an existing global SSH server'}
}

function Assert-WindowsSshStockShell {
  $registry=Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\OpenSSH' -ErrorAction SilentlyContinue
  if($registry.DefaultShell -or $registry.DefaultShellCommandOption){throw 'Requires stock cmd.exe OpenSSH shell at start'}
}

function Write-WindowsSshReceiptStage([hashtable]$Report,[string]$Receipt,[string]$Stage) {
  $timestamp=[DateTime]::UtcNow.ToString('o')
  $Report.stages+=@{stage=$Stage;utc=$timestamp}
  try {
    $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($Report | ConvertTo-Json -Depth 6))
    $temporary="$Receipt.pending"
    $stream=[IO.FileStream]::new($temporary,[IO.FileMode]::Create,[IO.FileAccess]::Write,[IO.FileShare]::Read)
    try {$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)} finally {$stream.Dispose()}
    [IO.File]::Move($temporary,$Receipt,$true)
    $written=$true
  } catch {$written=$false;Write-Warning 'Progress receipt could not be updated; cleanup must still run'}
  Write-Host "Native SSH stage: $Stage ($timestamp)"
  return $written
}

function Install-WindowsInboxSshCapability([ValidateSet('arm64','x64')][string]$Arch,[hashtable]$Report,[scriptblock]$Stage) {
  Assert-IsolatedWindowsSshCi $Arch
  Assert-WindowsSshGlobalServerDormant 'inbox'
  Assert-WindowsSshStockShell
  & $Stage 'inbox-capability-start'
  $capability=Get-WindowsCapability -Online -Name 'OpenSSH.Server~~~~0.0.1.0'
  $Report.inboxCapabilityInitialState=[string]$capability.State
  if($capability.State -ne 'Installed'){Add-WindowsCapability -Online -Name 'OpenSSH.Server~~~~0.0.1.0' | Out-Null}
  Assert-WindowsSshGlobalServerDormant 'inbox'
  Assert-WindowsSshStockShell
  & $Stage 'inbox-capability-complete'
}

function Initialize-WindowsInboxSshCapability([ValidateSet('arm64','x64')][string]$Arch,[string]$Receipt) {
  $report=@{scope='Windows inbox OpenSSH.Server capability preparation only';arch=$Arch;sourceSha=$env:GITHUB_SHA;runId=$env:GITHUB_RUN_ID;runAttempt=$env:GITHUB_RUN_ATTEMPT;runnerName=$env:RUNNER_NAME;imageVersion=$env:ImageVersion;status='running';stages=@();globalBootstrapCleanup='Disposable CI VM destruction is the boundary; no global sshd is started'}
  try {
    if(-not (Write-WindowsSshReceiptStage $report $Receipt 'preparation-start')){throw 'Initial progress receipt unavailable; refuse provisioning'}
    Install-WindowsInboxSshCapability $Arch $report {param($name)
      if(-not (Write-WindowsSshReceiptStage $report $Receipt $name)){throw 'Capability preparation progress receipt unavailable'}
    }
    $report.status='passed'
  } catch {$report.status='failed';$report.error=$_.Exception.Message;throw}
  finally {
    if(-not (Write-WindowsSshReceiptStage $report $Receipt 'preparation-finished')){throw 'Final capability preparation receipt unavailable'}
  }
}
