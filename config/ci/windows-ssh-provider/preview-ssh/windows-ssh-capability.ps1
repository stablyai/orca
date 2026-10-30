. (Join-Path $PSScriptRoot '../../windows-lifecycle-receipt.ps1')

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
  $written=Write-WindowsLifecycleReceipt $Report $Receipt
  if(-not $written){Write-Warning 'Progress receipt could not be updated; cleanup must still run'}
  Write-Host "Native SSH stage: $Stage ($timestamp)"
  return $written
}

function Install-WindowsInboxSshCapability([ValidateSet('arm64','x64')][string]$Arch,[hashtable]$Report,[scriptblock]$Stage,[Parameter(Mandatory=$true)][string]$LogDirectory) {
  Assert-IsolatedWindowsSshCi $Arch
  Assert-WindowsSshGlobalServerDormant 'inbox'
  Assert-WindowsSshStockShell
  & $Stage 'inbox-capability-start'
  New-Item -ItemType Directory -Force -Path $LogDirectory | Out-Null
  $invocation=[Guid]::NewGuid().ToString('N')
  $query=@{operation='query';status='running';log="inbox-capability-query-$invocation.log"}
  $Report.inboxCapabilityOperations=@($query)
  & $Stage 'inbox-capability-query-start'
  $watch=[Diagnostics.Stopwatch]::StartNew()
  try {
    $capability=Get-WindowsCapability -Online -Name 'OpenSSH.Server~~~~0.0.1.0' -LogPath (Join-Path $LogDirectory $query.log) -ErrorAction Stop
    $Report.inboxCapabilityInitialState=[string]$capability.State
    $query.status='passed'
  } catch {$query.status='failed';$query.error=$_.Exception.Message;throw}
  finally {$watch.Stop();$query.elapsedMs=$watch.ElapsedMilliseconds;& $Stage 'inbox-capability-query-finished'}
  if($capability.State -ne 'Installed'){
    $install=@{operation='install';status='running';log="inbox-capability-install-$invocation.log"}
    $Report.inboxCapabilityOperations+=@($install)
    & $Stage 'inbox-capability-install-start'
    $watch=[Diagnostics.Stopwatch]::StartNew()
    try {
      $result=Add-WindowsCapability -Online -Name 'OpenSSH.Server~~~~0.0.1.0' -LogPath (Join-Path $LogDirectory $install.log) -ErrorAction Stop
      $Report.inboxCapabilityInstallResult=@{path=$result.Path;online=$result.Online;restartNeeded=$result.RestartNeeded}
      $install.status='passed'
    } catch {$install.status='failed';$install.error=$_.Exception.Message;throw}
    finally {$watch.Stop();$install.elapsedMs=$watch.ElapsedMilliseconds;& $Stage 'inbox-capability-install-finished'}
  }
  & $Stage 'inbox-capability-guards-start'
  Assert-WindowsSshGlobalServerDormant 'inbox'
  Assert-WindowsSshStockShell
  & $Stage 'inbox-capability-complete'
}

function Initialize-WindowsInboxSshCapability([ValidateSet('arm64','x64')][string]$Arch,[string]$Receipt,[ValidateSet('overlap','serial')][string]$PreparationMode='overlap') {
  $report=@{scope='Windows inbox OpenSSH.Server capability preparation only';arch=$Arch;sourceSha=$env:GITHUB_SHA;runId=$env:GITHUB_RUN_ID;runAttempt=$env:GITHUB_RUN_ATTEMPT;runnerName=$env:RUNNER_NAME;imageVersion=$env:ImageVersion;preparationMode=$PreparationMode;status='running';stages=@();globalBootstrapCleanup='Disposable CI VM destruction is the boundary; no global sshd is started'}
  try {
    if(-not (Write-WindowsSshReceiptStage $report $Receipt 'preparation-start')){throw 'Initial progress receipt unavailable; refuse provisioning'}
    Install-WindowsInboxSshCapability $Arch $report {param($name)
      if(-not (Write-WindowsSshReceiptStage $report $Receipt $name)){throw 'Capability preparation progress receipt unavailable'}
    } ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($Receipt)))
    $report.status='passed'
  } catch {$report.status='failed';$report.error=$_.Exception.Message;throw}
  finally {
    if(-not (Write-WindowsSshReceiptStage $report $Receipt 'preparation-finished')){throw 'Final capability preparation receipt unavailable'}
  }
}
