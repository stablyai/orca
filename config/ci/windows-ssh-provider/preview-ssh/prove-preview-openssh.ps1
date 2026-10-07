# Ephemeral CI only. Preview ZIP or inbox capability binaries, always under a private service and accounts.
# -HiddenTools: the private accounts are denied every machine PATH directory holding one of these
# executables, and their own PATH carries logging shims for them, so SSH sessions have no host toolchain.
# -HostCellProbe receives a context hashtable (accounts, port, keys, shim log) once provisioning passes.
param([Parameter(Mandatory=$true)][string]$Receipt,[string]$Archive,[Parameter(Mandatory=$true)][ValidateSet('arm64','x64')][string]$Arch,[ValidateSet('preview','inbox')][string]$Server='preview',[scriptblock]$ProductionRouteProbe,[ValidateRange(1,6)][int]$Accounts=1,[ValidateRange(0,6)][int]$ForwardingAccounts=0,[string[]]$HiddenTools=@(),[scriptblock]$HostCellProbe,[string]$InboxPreparationReceipt)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'windows-ssh-capability.ps1')
$target=@{arm64=@{os='Arm64';folder='OpenSSH-ARM64';machine='0xAA64';archive='698c6aec31c1dd0fb996206e8741f4531a97355686b5431ef347d531b07fcd42'};x64=@{os='X64';folder='OpenSSH-Win64';machine='0x8664';archive='23f50f3458c4c5d0b12217c6a5ddfde0137210a30fa870e98b29827f7b43aba5'}}[$Arch]
$scopeServer=if($Server -eq 'inbox'){'Windows inbox OpenSSH.Server capability binaries'}else{'Microsoft Win32-OpenSSH 10.0.0.0p2-Preview'}
$report = @{scope="$scopeServer $Arch private loopback authentication and stock cmd.exe dispatch"; server=$Server; status='running'; imageVersion=$env:ImageVersion; cleanup=@('not-confirmed'); globalBootstrapCleanup='Not qualified: service bootstrap may create ProgramData SSH and OpenSSH registry entries; disposable CI VM destruction is the boundary'; observations=@(); stages=@(); diagnosticCaptureFailures=@()}
$script:receiptWritten=$false
function Write-Stage([string]$Stage) {
  if(Write-WindowsSshReceiptStage $report $Receipt $Stage){$script:receiptWritten=$true}
}
Write-Stage 'preflight-start'
if(-not $script:receiptWritten){throw 'Initial progress receipt unavailable; refuse provisioning'}
Assert-IsolatedWindowsSshCi $Arch
Write-Stage 'existing-server-query-start'
$inboxDir=Join-Path $env:WINDIR 'System32\OpenSSH'
Assert-WindowsSshGlobalServerDormant $Server
Write-Stage 'existing-server-query-complete'
Write-Stage 'default-shell-query-start'
$openSshKey = 'HKLM:\SOFTWARE\OpenSSH'
# Host-cell probes may set DefaultShell per cell; cleanup restores this stock state.
Assert-WindowsSshStockShell
Write-Stage 'default-shell-query-complete'
if($InboxPreparationReceipt){
  if($Server -ne 'inbox'){throw 'Inbox preparation receipt cannot qualify a preview server'}
  $preparation=Get-Content -LiteralPath $InboxPreparationReceipt -Raw | ConvertFrom-Json
  if($preparation.status -ne 'passed' -or $preparation.arch -ne $Arch -or $preparation.sourceSha -ne $env:GITHUB_SHA -or $preparation.runId -ne $env:GITHUB_RUN_ID -or $preparation.runAttempt -ne $env:GITHUB_RUN_ATTEMPT -or $preparation.runnerName -ne $env:RUNNER_NAME -or $preparation.imageVersion -ne $env:ImageVersion){throw 'Inbox preparation receipt identity or verdict mismatch'}
  $report.inboxCapabilityPreparation=$preparation
}
$id = [Guid]::NewGuid().ToString('N').Substring(0,10)
$name = "orca$id"
$accountNames = @($name) + @(if($Accounts -gt 1){2..$Accounts | ForEach-Object {"$name$_"}})
$serviceName = "orca-sshd-$id"
$root = Join-Path $env:RUNNER_TEMP "ossh-$id"
Write-Stage 'private-directory-create-start'
New-Item -ItemType Directory -Path $root | Out-Null
Write-Stage 'private-directory-create-complete'
$report.root=$root
$createdService=$false; $sid=$null; $ownedServerPid=$null
# Not $accounts: PowerShell names are case-insensitive, so that would rebind the [int] -Accounts param.
$ownedAccounts=[Collections.Generic.List[hashtable]]::new()
$deniedToolDirs=[Collections.Generic.List[string]]::new()
$sshDir=if($Server -eq 'inbox'){$inboxDir}else{Join-Path $root $target.folder}
$sshdLog=Join-Path $root 'private-sshd.log'
$serviceStartAttempt=$null
function Diagnostic-Categories([string]$Text) {
  $categories=@()
  foreach($category in @('connection established','remote protocol version','server host key','host key verification failed','offering public key','server accepts key','authenticated to','sending command','exit status','permission denied','connection closed','connection reset','bad permissions','unable to load host key','no hostkeys available','failed to create','fatal','userauth','accepted publickey','starting session','createprocess','logonuser')){
    if($Text.IndexOf($category,[StringComparison]::OrdinalIgnoreCase) -ge 0){$categories+=$category}
  }
  return $categories
}
function Diagnostic-ExitStatuses([string]$Text) {
  $bounded=$Text.Substring(0,[Math]::Min($Text.Length,16384))
  $matches=[regex]::Matches($bounded,'(?im)\b(?:exit status|exit code|error(?: code)?)\s*[:=]?\s*(-?\d{1,10})\b')
  return @($matches | Select-Object -First 8 | ForEach-Object {[long]$_.Groups[1].Value})
}
# Ephemeral keys and accounts only: failing lines are what makes a refused login diagnosable.
function Diagnostic-Excerpt([string]$Text) {
  return @($Text -split '\r?\n' | Where-Object {$_ -match '(?i)error|fail|refus|denied|bad |invalid|not allowed|fatal|disconnect|userauth|pubkey|authorized'} | Select-Object -Last 40 | ForEach-Object {$_.Substring(0,[Math]::Min($_.Length,300))})
}
function Invoke-Bounded([string]$Program,[string[]]$Arguments,[int]$Seconds=20,[switch]$AllowFailure) {
  Write-Stage ('command-'+[IO.Path]::GetFileName($Program)+'-start')
  $start=[Diagnostics.ProcessStartInfo]::new($Program)
  $start.UseShellExecute=$false; $start.CreateNoWindow=$true
  $start.RedirectStandardOutput=$true; $start.RedirectStandardError=$true
  foreach($argument in $Arguments){$start.ArgumentList.Add($argument)}
  $process=[Diagnostics.Process]::new();$process.StartInfo=$start
  try {
    if(-not $process.Start()){throw 'Owned command failed to start'}
    $stdout=$process.StandardOutput.ReadToEndAsync();$stderr=$process.StandardError.ReadToEndAsync()
    $timedOut=-not $process.WaitForExit($Seconds*1000)
    if($timedOut){$process.Kill($true);if(-not $process.WaitForExit(5000)){throw 'Owned command kill unconfirmed'}}
    if(-not [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($stdout,$stderr),5000)){throw 'Owned command output drain deadline exceeded'}
    $output=$stdout.GetAwaiter().GetResult();$errorText=$stderr.GetAwaiter().GetResult()
    if($output.Length+$errorText.Length -gt 1048576){throw 'Owned command output limit exceeded'}
    if([IO.Path]::GetFileName($Program) -eq 'ssh.exe'){
      $report.sshClient=@{timedOut=$timedOut;exitCode=$process.ExitCode;stderrBytes=$errorText.Length;categories=@(Diagnostic-Categories $errorText);reportedExitStatuses=@(Diagnostic-ExitStatuses $errorText);excerpt=@(Diagnostic-Excerpt $errorText)}
      Write-Stage 'ssh-client-result'
    }
    if([IO.Path]::GetFileName($Program) -eq 'sftp.exe'){
      $report.sftpClient=@{timedOut=$timedOut;exitCode=$process.ExitCode;stderrBytes=$errorText.Length;categories=@(Diagnostic-Categories $errorText);reportedExitStatuses=@(Diagnostic-ExitStatuses $errorText)}
      Write-Stage 'sftp-client-result'
    }
    if($timedOut){throw 'Owned command deadline exceeded'}
    if($process.ExitCode -ne 0 -and -not $AllowFailure){throw "Owned command failed: $([IO.Path]::GetFileName($Program)) exit $($process.ExitCode)"}
    Write-Stage ('command-'+[IO.Path]::GetFileName($Program)+'-complete')
    return @{code=$process.ExitCode; stdout=$output}
  } finally {$process.Dispose()}
}
function Record-PrivateServiceDiagnostics([switch]$AfterStop) {
  Write-Stage 'private-service-diagnostics-start'
  $captureStage='service-query'
  try {
    $state=Get-CimInstance Win32_Service -Filter "Name='$serviceName'"
    if($state){
      $diagnostic=@{state=$state.State;exitCode=$state.ExitCode;serviceSpecificExitCode=$state.ServiceSpecificExitCode;pid=$state.ProcessId;localSystem=($state.StartName -eq 'LocalSystem');privatePath=($state.PathName -like "*$root*")}
    } else {$diagnostic=@{absent=$true}}
    if($AfterStop){$report.serviceAfterStop=$diagnostic}else{$report.serviceDiagnostics=$diagnostic}
    if($serviceStartAttempt -and -not $AfterStop){
      try {
        $events=@(Get-WinEvent -FilterHashtable @{LogName='System';ProviderName='Service Control Manager';StartTime=$serviceStartAttempt} -MaxEvents 50 -ErrorAction Stop | Where-Object {$_.Properties.Value -contains $serviceName})
        $report.serviceEvents=@($events | ForEach-Object {@{id=$_.Id;utc=$_.TimeCreated.ToUniversalTime().ToString('o');level=$_.Level}})
      } catch {$report.serviceEventsUnavailable=$true}
    }
    $captureStage='private-log'
    if(Test-Path -LiteralPath $sshdLog){
      $file=[IO.FileStream]::new($sshdLog,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite)
      try {
        $buffer=[byte[]]::new(16384)
        $file.Position=[Math]::Max(0,$file.Length-$buffer.Length)
        $offset=$file.Position
        $count=$file.Read($buffer,0,$buffer.Length)
        $text=[Text.Encoding]::UTF8.GetString($buffer,0,$count)
        $classes=@(Diagnostic-Categories $text)
        $report.privateLog=@{exists=$true;bytes=$file.Length;examinedBytes=$count;offset=$offset;errorClasses=$classes;reportedExitStatuses=@(Diagnostic-ExitStatuses $text);excerpt=@(Diagnostic-Excerpt $text)}
      } finally {$file.Dispose()}
    } else {$report.privateLog=@{exists=$false}}
  } catch {$report.diagnosticCaptureFailures+=@{stage=$captureStage;afterStop=[bool]$AfterStop;hresult=$_.Exception.HResult;kind=$_.Exception.GetType().Name}}
  Write-Stage 'private-service-diagnostics-complete'
}

# Drops every PATH entry holding one of the tools; entries are expanded, as a session sees them.
# Why .NET and not Join-Path: Join-Path throws on an entry naming a drive this runner lacks.
function Split-HostToolchainPath([string]$PathValue,[string[]]$Tools) {
  $kept=[Collections.Generic.List[string]]::new();$hidden=[Collections.Generic.List[string]]::new()
  foreach($entry in @($PathValue -split ';' | Where-Object {$_})){
    $expanded=[Environment]::ExpandEnvironmentVariables($entry)
    $holds=@(foreach($tool in $Tools){foreach($extension in @('.exe','.cmd','.bat')){if([IO.File]::Exists([IO.Path]::Combine($expanded,"$tool$extension"))){"$tool$extension"}}})
    if($holds.Count){$hidden.Add($expanded)}else{$kept.Add($expanded)}
  }
  return @{kept=@($kept);hidden=@($hidden)}
}

function Machine([string]$Path){
  $file=[IO.File]::OpenRead($Path)
  try{$reader=[IO.BinaryReader]::new($file);$file.Position=0x3c;$position=$reader.ReadInt32();$file.Position=$position;if($reader.ReadUInt32()-ne 0x00004550){throw 'Invalid PE'};return ('0x{0:X4}'-f $reader.ReadUInt16())}finally{$file.Dispose()}
}
try {
  if($Server -eq 'preview'){
    Write-Stage 'preview-archive-verify-start'
    if(-not $Archive){throw 'Preview mode requires the pinned archive'}
    $expectedArchive=$target.archive
    if((Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedArchive){throw 'Preview archive hash mismatch'}
    $report.archiveSha256=$expectedArchive
    Write-Stage 'preview-archive-verify-complete'
    Write-Stage 'preview-extract-start'
    # The exact hash is checked before extraction; never execute included installer scripts.
    [IO.Compression.ZipFile]::ExtractToDirectory($Archive,$root)
    Write-Stage 'preview-extract-complete'
    Write-Stage 'preview-native-input-verification-start'
    $manifest=Get-Content -LiteralPath (Join-Path $PSScriptRoot "preview-native-inputs-$Arch.json") -Raw | ConvertFrom-Json
    if($manifest.archiveSha256 -ne $expectedArchive -or $manifest.files.Count -ne 15){throw 'Preview input manifest mismatch'}
    $nativeFiles=@(Get-ChildItem -LiteralPath $sshDir -File | Where-Object {$_.Extension -in @('.exe','.dll')})
    if($nativeFiles.Count -ne $manifest.files.Count){throw 'Unexpected preview native input count'}
    $verified=@()
    foreach($file in $nativeFiles){
      $expected=@($manifest.files | Where-Object name -eq $file.Name)
      if($expected.Count -ne 1 -or (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected[0].sha256){throw 'Preview native input hash mismatch'}
      if((Machine $file.FullName) -ne $target.machine){throw "Preview native input is not $Arch"}
      $signature=Get-AuthenticodeSignature -LiteralPath $file.FullName
      if($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '(?:^|, )O=Microsoft Corporation(?:,|$)'){throw 'Preview native input Microsoft signature invalid'}
      $verified+=@{name=$file.Name;sha256=$expected[0].sha256;machine=$target.machine;signature='Valid';publisher=$signature.SignerCertificate.Subject}
    }
    $report.nativeInputs=$verified
    Write-Stage 'preview-native-input-verification-complete'
  } else {
    Install-WindowsInboxSshCapability $Arch $report {param($stage) Write-Stage $stage}
    $verified=@()
    foreach($binary in @('sshd.exe','ssh.exe','ssh-keygen.exe','sftp.exe','sftp-server.exe')){
      $path=Join-Path $sshDir $binary
      if((Machine $path) -ne $target.machine){throw "Inbox native input is not $Arch"}
      $signature=Get-AuthenticodeSignature -LiteralPath $path
      if($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '(?:^|, )O=Microsoft Corporation(?:,|$)'){throw 'Inbox native input Microsoft signature invalid'}
      $verified+=@{name=$binary;sha256=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant();version=(Get-Item -LiteralPath $path).VersionInfo.FileVersion;machine=$target.machine;signature='Valid'}
    }
    $report.nativeInputs=$verified
  }
  $sshd=Join-Path $sshDir 'sshd.exe';$ssh=Join-Path $sshDir 'ssh.exe';$keygen=Join-Path $sshDir 'ssh-keygen.exe'
  $password=ConvertTo-SecureString ([Guid]::NewGuid().ToString('N')+'aA!7') -AsPlainText -Force
  foreach($accountName in $accountNames){
    Write-Stage 'private-user-collision-query-start'
    if(Get-LocalUser -Name $accountName -ErrorAction SilentlyContinue){throw 'Private username collision'}
    Write-Stage 'private-user-collision-query-complete'
    $account=@{name=$accountName;sid=$null;home=$null}
    $ownedAccounts.Add($account)
    Write-Stage 'private-user-create-start'
    $user=New-LocalUser -Name $accountName -Password $password -AccountNeverExpires -PasswordNeverExpires -Description 'Ephemeral Orca SSH qualification'
    Write-Stage 'private-user-create-complete'
    $account.sid=$user.SID.Value
    Write-Stage 'private-user-group-start'
    Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $user
    Write-Stage 'private-user-group-complete'
  }
  $sid=$ownedAccounts[0].sid
  # No administrator membership or real runner auth files; DefaultShell is restored at cleanup.
  Invoke-Bounded icacls.exe (@($root,'/inheritance:r','/grant:r','*S-1-5-18:(OI)(CI)F','*S-1-5-32-544:(OI)(CI)F')+@($ownedAccounts | ForEach-Object {"*$($_.sid):(RX)"})) | Out-Null
  # /T visits files too: grant direct rights instead of directory-only inheritance flags.
  $runnerSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  # Never rewrite System32 ACLs; only the private preview copy is re-permissioned.
  if($Server -eq 'preview'){Invoke-Bounded icacls.exe (@($sshDir,'/inheritance:r','/grant:r','*S-1-5-18:F','*S-1-5-32-544:F',"*$($runnerSid):F")+@($ownedAccounts | ForEach-Object {"*$($_.sid):RX"})+@('/T')) | Out-Null}
  $report.nativeAcl=@{directory=(Get-Acl -LiteralPath $sshDir).Sddl;keygen=(Get-Acl -LiteralPath $keygen).Sddl}
  Write-Stage 'native-acl-recorded'
  $hostKey=Join-Path $root 'host_key';$clientKey=Join-Path $root 'client_key'
  Write-Stage 'private-key-create-start'
  Invoke-Bounded $keygen @('-q','-t','ed25519','-N','','-f',$hostKey) | Out-Null
  Invoke-Bounded $keygen @('-q','-t','ed25519','-N','','-f',$clientKey) | Out-Null
  Write-Stage 'private-key-create-complete'
  # Service host keys are readable only by SYSTEM and administrators.
  Invoke-Bounded icacls.exe @($hostKey,'/inheritance:r','/grant:r','*S-1-5-18:F','*S-1-5-32-544:F') | Out-Null
  Invoke-Bounded icacls.exe @($hostKey,'/setowner','*S-1-5-18') | Out-Null
  $hostAcl=Get-Acl -LiteralPath $hostKey
  $hostAcl.SetSecurityDescriptorSddlForm('D:P(A;;FA;;;SY)(A;;FA;;;BA)',[Security.AccessControl.AccessControlSections]::Access)
  Set-Acl -LiteralPath $hostKey -AclObject $hostAcl
  $report.hostKeyAcl=(Get-Acl -LiteralPath $hostKey).Sddl
  # One file per account: inbox sshd 8.1 refuses a keys file any other account can even read.
  foreach($account in $ownedAccounts){
    $authorized=Join-Path $root "authorized_keys_$($account.name)"
    Copy-Item -LiteralPath "$clientKey.pub" -Destination $authorized
    Invoke-Bounded icacls.exe @($authorized,'/inheritance:r','/grant:r','*S-1-5-18:F','*S-1-5-32-544:F',"*$($account.sid):R") | Out-Null
  }
  $authorized=Join-Path $root 'authorized_keys_%u'
  $listener=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0);$listener.Start();$port=$listener.LocalEndpoint.Port;$listener.Stop()
  $config=Join-Path $root 'sshd_config'
  $hostPosix=$hostKey.Replace('\','/');$authPosix=$authorized.Replace('\','/');$pidPosix=(Join-Path $root 'sshd.pid').Replace('\','/')
  $sftpServer=Join-Path $sshDir 'sftp-server.exe'
  $sftpServerPosix=$sftpServer.Replace('\','/')
  $report.sftpServer=@{pinnedPath=$true;sha256=(Get-FileHash -LiteralPath $sftpServer -Algorithm SHA256).Hash.ToLowerInvariant();acl=(Get-Acl -LiteralPath $sftpServer).Sddl}
  @"
Port $port
ListenAddress 127.0.0.1
HostKey "$hostPosix"
PidFile "$pidPosix"
AuthorizedKeysFile "$authPosix"
AllowUsers $($accountNames -join ' ')
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
StrictModes yes
AllowTcpForwarding no
AllowAgentForwarding no
PermitTunnel no
PermitTTY no
Subsystem sftp "$sftpServerPosix"
LogLevel DEBUG1
$(@($accountNames | Select-Object -Last $ForwardingAccounts | ForEach-Object {"Match User $_`n  AllowTcpForwarding local"}) -join "`n")
"@ | Set-Content -LiteralPath $config -Encoding ascii
  Write-Stage 'server-config-validate-start'
  Invoke-Bounded $sshd @('-t','-f',$config) | Out-Null
  Write-Stage 'server-config-validate-complete'
  # A distinct LocalSystem service supplies Windows sshd's token-creation privileges.
  Write-Stage 'private-service-collision-query-start'
  if(Get-Service -Name $serviceName -ErrorAction SilentlyContinue){throw 'Private service name collision'}
  Write-Stage 'private-service-collision-query-complete'
  $createdService=$true
  Write-Stage 'private-service-create-start'
  New-Service -Name $serviceName -BinaryPathName "`"$sshd`" -f `"$config`" -E `"$sshdLog`"" -StartupType Manual | Out-Null
  Write-Stage 'private-service-create-complete'
  $shimDir=$null;$toolLog=$null
  if($HiddenTools.Count){
    Write-Stage 'host-toolchain-hide-start'
    $shimDir=Join-Path $root 'shims';$toolLogDir=Join-Path $root 'tool-log';$toolLog=Join-Path $toolLogDir 'forbidden-tool-calls.log'
    New-Item -ItemType Directory -Path $shimDir,$toolLogDir | Out-Null
    foreach($tool in $HiddenTools){
      if($tool -notmatch '^[A-Za-z0-9+_.-]+$'){throw 'Unsafe hidden tool name'}
      # Name only: arguments may hold cmd metacharacters that would break the redirection.
      "@>>`"$toolLog`" echo %~n0`r`n@exit /b 127`r`n" | Set-Content -LiteralPath (Join-Path $shimDir "$tool.cmd") -Encoding ascii -NoNewline
    }
    Invoke-Bounded icacls.exe (@($shimDir,'/grant')+@($ownedAccounts | ForEach-Object {"*$($_.sid):(OI)(CI)RX"})) | Out-Null
    Invoke-Bounded icacls.exe (@($toolLogDir,'/grant')+@($ownedAccounts | ForEach-Object {"*$($_.sid):(OI)(CI)M"})) | Out-Null
    $machinePath=(Get-Item -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment').GetValue('Path','',[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $split=Split-HostToolchainPath $machinePath ($HiddenTools+@('node'))
    $kept=$split.kept;$hidden=$split.hidden
    # Why ACLs, not PATH: Win32-OpenSSH builds the session PATH from the machine and user registry
    # values, ignoring the service environment and SetEnv. Deny ACEs name only the private accounts.
    foreach($directory in $hidden){
      Invoke-Bounded icacls.exe (@($directory.TrimEnd('\'),'/deny')+@($ownedAccounts | ForEach-Object {"*$($_.sid):(OI)(CI)RX"})) 120 | Out-Null
      $deniedToolDirs.Add($directory)
    }
    $report.hostToolchain=@{hiddenPathEntries=@($hidden);keptPathEntries=$kept.Count;shimmedTools=@($HiddenTools);unhideable=@('System32 and the WindowsApps user path stay: powershell.exe, cmd.exe and where.exe live there')}
    Write-Stage 'host-toolchain-hide-complete'
  }
  Invoke-Bounded sc.exe @('privs',$serviceName,'SeAssignPrimaryTokenPrivilege/SeTcbPrivilege/SeBackupPrivilege/SeRestorePrivilege/SeImpersonatePrivilege') | Out-Null
  Write-Stage 'private-service-start-start'
  $preexisting=@(Get-CimInstance Win32_Process | Where-Object {$_.ExecutablePath -and $_.ExecutablePath.StartsWith($sshDir+'\',[StringComparison]::OrdinalIgnoreCase)} | ForEach-Object {"$($_.ProcessId)/$($_.CreationDate.Ticks)"})
  $report.preexistingServerDirectoryProcesses=$preexisting.Count
  $serviceStartAttempt=[DateTime]::Now.AddSeconds(-1)
  Start-Service -Name $serviceName
  Write-Stage 'private-service-start-complete'
  Write-Stage 'private-service-identity-start'
  $service=Get-CimInstance Win32_Service -Filter "Name='$serviceName'"
  Write-Stage 'private-service-identity-complete'
  if($service.StartName -ne 'LocalSystem' -or -not $service.ProcessId){throw 'Private service identity unavailable'}
  $ownedServerPid=$service.ProcessId
  $keyFields=(Get-Content -LiteralPath "$hostKey.pub" -Raw).Trim().Split(' ')
  $known=Join-Path $root 'known_hosts'
  "[127.0.0.1]:$port $($keyFields[0]) $($keyFields[1])" | Set-Content -LiteralPath $known -Encoding ascii
  $nonce=[Guid]::NewGuid().ToString('N')
  function Get-PrivateSshArgs([string]$Account){@('-v','-F','NUL','-T','-p',[string]$port,'-i',$clientKey,'-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','StrictHostKeyChecking=yes','-o',"UserKnownHostsFile=$known",'-o','ConnectTimeout=5',"$Account@127.0.0.1")}
  $sshArgs=Get-PrivateSshArgs $name
  $report.sshFirstLoginBudgetSeconds=60
  foreach($account in $ownedAccounts){
    $deadline=[DateTime]::UtcNow.AddSeconds(75);$probe=$null
    Write-Stage 'ssh-authentication-start'
    do {
      $remainingSeconds=[Math]::Max(1,[Math]::Min(60,[Math]::Floor(($deadline-[DateTime]::UtcNow).TotalSeconds)))
      $attemptClock=[Diagnostics.Stopwatch]::StartNew()
      try {$probe=Invoke-Bounded $ssh ((Get-PrivateSshArgs $account.name)+@("echo $nonce && whoami && echo %COMSPEC%")) $remainingSeconds -AllowFailure}
      finally {$report.sshAttemptElapsedMs=$attemptClock.ElapsedMilliseconds;Write-Stage 'ssh-attempt-finished'}
      if($probe.code -eq 0){break};Start-Sleep -Milliseconds 250
    } while([DateTime]::UtcNow -lt $deadline)
    if($probe.code -ne 0 -or $probe.stdout -notmatch [regex]::Escape($nonce) -or $probe.stdout -notmatch "\\$($account.name)(?:\r?\n)" -or $probe.stdout -notmatch '(?i)cmd.exe'){throw 'Real SSH authentication/default-shell proof failed'}
    # The first logon created the profile; its path is where the relay store lands.
    $account.home=@(Get-CimInstance Win32_UserProfile | Where-Object SID -eq $account.sid | ForEach-Object LocalPath)[0]
    if(-not $account.home){throw 'Private account profile was not created by its SSH logon'}
    if($shimDir){
      # The session appends the user PATH to the machine PATH; the denied directories never match first.
      $userEnvironment="Registry::HKEY_USERS\$($account.sid)\Environment"
      if(-not (Test-Path -LiteralPath $userEnvironment)){throw 'Private account hive not loaded after its SSH logon'}
      $userPath=(Get-Item -LiteralPath $userEnvironment).GetValue('Path','',[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      New-ItemProperty -LiteralPath $userEnvironment -Name Path -PropertyType ExpandString -Value ((@($shimDir)+@($userPath -split ';' | Where-Object {$_})) -join ';') -Force | Out-Null
    }
    Write-Stage 'ssh-authentication-complete'
  }
  if($HiddenTools.Count){
    Write-Stage 'host-toolchain-session-proof-start'
    $pathProbe=Invoke-Bounded $ssh ($sshArgs+@('echo ORCA_PATH=%PATH%& where node.exe')) 30 -AllowFailure
    $sessionPath=([regex]::Match($pathProbe.stdout,'ORCA_PATH=([^\r\n]*)')).Groups[1].Value
    $visibleNode=@($pathProbe.stdout -split '\r?\n' | Where-Object {$_ -match '(?i)\\node\.exe\s*$'})
    # Every kept entry was checked free of the tools, so the shims only need to be on PATH at all.
    $report.hostToolchain.sessionPathHasShims=@($sessionPath -split ';' | Where-Object {$_.TrimEnd('\') -ieq $shimDir}).Count -gt 0
    $report.hostToolchain.sessionPathEntries=@($sessionPath -split ';' | Where-Object {$_}).Count
    $report.hostToolchain.sessionNodeVisible=@($visibleNode)
    if(-not $report.hostToolchain.sessionPathHasShims){throw 'SSH session PATH does not carry the toolchain shims'}
    if($visibleNode.Count -or $pathProbe.code -eq 0){throw 'SSH session still resolves a host node.exe'}
    Write-Stage 'host-toolchain-session-proof-complete'
  }
  Write-Stage 'listener-identity-start'
  $listeners=@(Get-NetTCPConnection -State Listen -LocalPort $port)
  Write-Stage 'listener-identity-complete'
  if(-not $listeners -or @($listeners|Where-Object {$_.LocalAddress -ne '127.0.0.1' -or $_.OwningProcess -ne $ownedServerPid}).Count){throw 'Listener escaped private loopback owner'}
  $report.observations=@{serverMachine=(Machine $sshd);clientMachine=(Machine $ssh);publisherVerified=$true;serviceAccount='LocalSystem';dedicatedUser=$true;dedicatedAccounts=$ownedAccounts.Count;pinnedHostKey=$true;stockCmdDispatch=$true;loopbackOnly=$true;port=$port;servicePid=$ownedServerPid}
  if ($ProductionRouteProbe -or $HostCellProbe) {
    Write-Stage 'sftp-preflight-start'
    $sftpBatch=Join-Path $root 'sftp-probe.txt'
    "pwd`nquit" | Set-Content -LiteralPath $sftpBatch -Encoding ascii
    $sftp=Join-Path $sshDir 'sftp.exe'
    $sftpArgs=@('-v','-S',$ssh,'-F','NUL','-P',[string]$port,'-i',$clientKey,'-b',$sftpBatch,'-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','StrictHostKeyChecking=yes','-o',"UserKnownHostsFile=$known",'-o','ConnectTimeout=5',"$name@127.0.0.1")
    $sftpProof=Invoke-Bounded $sftp $sftpArgs 30 -AllowFailure
    if($sftpProof.code -ne 0){throw 'Pinned native SFTP subsystem preflight failed'}
    $report.sftpSubsystem=@{implementation='pinned external sftp-server.exe';authenticatedBatchPassed=$true}
    Write-Stage 'sftp-preflight-complete'
    if($ProductionRouteProbe){
      Write-Stage 'production-route-start'
      & $ProductionRouteProbe $name $port $clientKey $known
      $report.productionRoute='passed-authenticated-cleanup'
      Write-Stage 'production-route-complete'
    }
    if($HostCellProbe){
      Write-Stage 'host-cell-probe-start'
      & $HostCellProbe @{accounts=@($ownedAccounts | ForEach-Object {@{name=$_.name;home=$_.home}});port=$port;identityFile=$clientKey;knownHosts=$known;forbiddenToolLog=$toolLog;sshExe=$ssh;sshdLog=$sshdLog}
      $report.hostCellProbe='passed'
      Write-Stage 'host-cell-probe-complete'
    }
  }
  $report.status='proof-passed-cleanup-pending'
} catch {
  $report.status='failed';$report.error=$_.Exception.Message
} finally {
  try {
    Record-PrivateServiceDiagnostics
    Write-Stage 'cleanup-start'
    Write-Stage 'cleanup-default-shell-start'
    # Preflight proved both values unset; the key itself may now also hold capability-installer values.
    if(Test-Path -LiteralPath $openSshKey){Remove-ItemProperty -LiteralPath $openSshKey -Name DefaultShell,DefaultShellCommandOption -ErrorAction SilentlyContinue}
    $restored=Get-ItemProperty -LiteralPath $openSshKey -ErrorAction SilentlyContinue
    if($restored.DefaultShell -or $restored.DefaultShellCommandOption){throw 'DefaultShell restore failed'}
    Write-Stage 'cleanup-default-shell-complete'
    Write-Stage 'cleanup-service-query-start'
    $privateService=Get-CimInstance Win32_Service -Filter "Name='$serviceName'"
    Write-Stage 'cleanup-service-query-complete'
    if($createdService -and $privateService -and ($privateService.PathName -notlike "*$root*" -or ($ownedServerPid -and $privateService.ProcessId -and $privateService.ProcessId -ne $ownedServerPid))){throw 'Private service identity changed; refuse stop'}
    Write-Stage 'cleanup-child-accounting-start'
    $rows=@(Get-CimInstance Win32_Process)
    $ownedChildren=@($rows | Where-Object {$_.ExecutablePath -and $_.ExecutablePath.StartsWith($sshDir+'\',[StringComparison]::OrdinalIgnoreCase) -and "$($_.ProcessId)/$($_.CreationDate.Ticks)" -notin $preexisting})
    $report.childrenBeforeStop=@($ownedChildren | ForEach-Object {@{pid=$_.ProcessId;parentPid=$_.ParentProcessId;created=$_.CreationDate.ToUniversalTime().ToString('o');image=[IO.Path]::GetFileName($_.ExecutablePath)}})
    Write-Stage 'cleanup-child-accounting-complete'
    Write-Stage 'cleanup-service-stop-delete-start' 
    if($createdService){Stop-Service -Name $serviceName -Force -ErrorAction SilentlyContinue;Invoke-Bounded sc.exe @('delete',$serviceName) | Out-Null}
    Write-Stage 'cleanup-service-stop-delete-complete'
    Write-Stage 'cleanup-process-exit-start'
    $exitDeadline=[DateTime]::UtcNow.AddSeconds(10)
    while($ownedServerPid -and (Get-Process -Id $ownedServerPid -ErrorAction SilentlyContinue) -and [DateTime]::UtcNow -lt $exitDeadline){Start-Sleep -Milliseconds 100}
    if($ownedServerPid -and (Get-Process -Id $ownedServerPid -ErrorAction SilentlyContinue)){throw 'Private sshd process still live; no PID-only kill attempted'}
    Write-Stage 'cleanup-process-exit-complete'
    Write-Stage 'cleanup-service-absence-start'
    $serviceDeadline=[DateTime]::UtcNow.AddSeconds(10)
    while($createdService -and (Get-Service -Name $serviceName -ErrorAction SilentlyContinue) -and [DateTime]::UtcNow -lt $serviceDeadline){Start-Sleep -Milliseconds 100}
    if($createdService -and (Get-Service -Name $serviceName -ErrorAction SilentlyContinue)){throw 'Private service still registered'}
    Write-Stage 'cleanup-service-absence-complete'
    Record-PrivateServiceDiagnostics -AfterStop
    Write-Stage 'cleanup-child-exit-start'
    $childDeadline=[DateTime]::UtcNow.AddSeconds(10)
    do {
      $remaining=@(Get-CimInstance Win32_Process | Where-Object {$_.ExecutablePath -and $_.ExecutablePath.StartsWith($sshDir+'\',[StringComparison]::OrdinalIgnoreCase) -and "$($_.ProcessId)/$($_.CreationDate.Ticks)" -notin $preexisting})
      if(-not $remaining.Count){break};Start-Sleep -Milliseconds 200
    } while([DateTime]::UtcNow -lt $childDeadline)
    $report.childrenAfterStop=@($remaining | ForEach-Object {@{pid=$_.ProcessId;parentPid=$_.ParentProcessId;created=$_.CreationDate.ToUniversalTime().ToString('o');image=[IO.Path]::GetFileName($_.ExecutablePath)}})
    Write-Stage 'cleanup-child-exit-complete'
    if($remaining.Count){throw 'Private SSH child processes remain; preserve files and discard ephemeral runner'}
    Write-Stage 'cleanup-toolchain-acl-start'
    foreach($directory in $deniedToolDirs){Invoke-Bounded icacls.exe (@($directory.TrimEnd('\'),'/remove:d')+@($ownedAccounts | ForEach-Object {"*$($_.sid)"})) 120 | Out-Null}
    Write-Stage 'cleanup-toolchain-acl-complete'
    Write-Stage 'cleanup-user-profile-start' 
    $profileTargets=@(foreach($account in $ownedAccounts){
      if($account.sid){@{sid=$account.sid;watch=$null;done=$false;profiles=@();waitMs=0;disposition=$null}}
    })
    $report.profileCleanup=@()
    $report.privateProfiles=@()
    do {
      foreach($entry in @($profileTargets | Where-Object {-not $_.done})){
        if(-not $entry.watch){$entry.watch=[Diagnostics.Stopwatch]::StartNew()}
        $profiles=@(Get-CimInstance Win32_UserProfile -Filter "SID='$($entry.sid)'")
        if(@($profiles | Where-Object SID -ne $entry.sid).Count){throw 'Private profile query returned an unrelated SID'}
        if(@($profiles | Where-Object Loaded).Count -and $entry.watch.ElapsedMilliseconds -lt 30000){continue}
        # A profile may reload after the polling snapshot.
        $profiles=@(Get-CimInstance Win32_UserProfile -Filter "SID='$($entry.sid)'")
        if(@($profiles | Where-Object SID -ne $entry.sid).Count){throw 'Private profile query returned an unrelated SID'}
        $loadedProfiles=@($profiles | Where-Object Loaded)
        if($loadedProfiles.Count -and $entry.watch.ElapsedMilliseconds -lt 30000){continue}
        $profiles | Where-Object {-not $_.Loaded} | Remove-CimInstance
        $entry.profiles=@($profiles | ForEach-Object {@{loaded=$_.Loaded;status=$_.Status}})
        $entry.waitMs=$entry.watch.ElapsedMilliseconds
        $entry.disposition=if($loadedProfiles.Count){'Loaded profile retained for disposable CI VM destruction'}else{'Unloaded profile removed'}
        $entry.done=$true
        $report.profileCleanup=@($profileTargets | Where-Object done | ForEach-Object disposition)
        $report.privateProfiles=@($profileTargets | Where-Object done | ForEach-Object {@{sid=$_.sid;waitMs=$_.waitMs;profiles=$_.profiles;disposition=$_.disposition}})
        $report.profileUnloadWaitMs=$entry.waitMs
        $report.privateProfile=$entry.profiles
        Write-Stage 'cleanup-user-profile-observed'
      }
      if(@($profileTargets | Where-Object {-not $_.done}).Count){Start-Sleep -Milliseconds 500}
    } while(@($profileTargets | Where-Object {-not $_.done}).Count)
    if($profileTargets.Count){
      $report.profileUnloadWaitMs=$profileTargets[-1].waitMs
      $report.privateProfile=$profileTargets[-1].profiles
    }
    Write-Stage 'cleanup-user-profile-complete'
    Write-Stage 'cleanup-user-start'
    foreach($account in $ownedAccounts){
      if(Get-LocalUser -Name $account.name -ErrorAction SilentlyContinue){Remove-LocalUser -Name $account.name}
      if(Get-LocalUser -Name $account.name -ErrorAction SilentlyContinue){throw 'Private account still exists'}
    }
    Write-Stage 'cleanup-user-complete'
    Write-Stage 'cleanup-private-files-start'
    Remove-Item -LiteralPath $root -Recurse -Force
    Write-Stage 'cleanup-private-files-complete'
    if($report.status -eq 'proof-passed-cleanup-pending'){$report.status='passed'}
    $report.cleanup=@('private service stopped/deleted','owned sshd exit verified','private account removed; profile disposition recorded separately','private keys removed')
  } catch {$report.status='failed';$report.cleanup=@('cleanup unverifiable; discard ephemeral runner');$report.cleanupError=$_.Exception.Message}
  Write-Stage 'finished'
}
if($report.status -ne 'passed'){throw 'Native OpenSSH qualification failed; inspect sanitized receipt'}
