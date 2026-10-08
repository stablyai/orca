$ErrorActionPreference='Stop'
$errors=$null;$tokens=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'prove-preview-openssh.ps1'),[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Fixture failed to parse'}
# Script-scope assignments share one case-insensitive namespace with typed params: $accounts rebinds [int]$Accounts.
foreach($script in @($ast,[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot '../invoke-pinned-relay-cells.ps1'),[ref]$null,[ref]$null))){
  $params=@($script.ParamBlock.Parameters | ForEach-Object {$_.Name.VariablePath.UserPath})
  $shadows=@($script.FindAll({param($node) $node -is [Management.Automation.Language.AssignmentStatementAst] -and $node.Left -is [Management.Automation.Language.VariableExpressionAst]},$true) | Where-Object {
    $parent=$_.Parent;while($parent -and $parent -isnot [Management.Automation.Language.FunctionDefinitionAst] -and $parent -isnot [Management.Automation.Language.ScriptBlockExpressionAst]){$parent=$parent.Parent}
    -not $parent -and $_.Left.VariablePath.UserPath -in $params
  } | ForEach-Object {$_.Left.VariablePath.UserPath})
  if($shadows.Count){throw "Script-scope assignment rebinds a typed param: $($shadows -join ', ')"}
}
$definition=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Diagnostic-ExitStatuses'},$true)
. ([scriptblock]::Create($definition.Extent.Text))
function Assert-Statuses([string]$Text,[long[]]$Expected){
  $actual=@(Diagnostic-ExitStatuses $Text)
  if(($actual -join ',') -ne ($Expected -join ',')){throw 'Unexpected numeric diagnostic'}
}
Assert-Statuses "debug1: Exit status 3221225781`nclient secret path /private/id" @(3221225781)
Assert-Statuses 'CreateProcess error: 5; exit code -1073741515' @(5,-1073741515)
Assert-Statuses 'identity key-123, host 127.0.0.1 port 65000' @()
Assert-Statuses ('x'*16384+' exit status 123') @()
Assert-Statuses (('exit status 7; '*20)) @(7,7,7,7,7,7,7,7)
$split=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Split-HostToolchainPath'},$true)
. ([scriptblock]::Create($split.Extent.Text))
$pathRoot=Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString('N'))
try {
  $nodeDir=Join-Path $pathRoot 'nodejs';$gccDir=Join-Path $pathRoot 'mingw';$plainDir=Join-Path $pathRoot 'tools'
  New-Item -ItemType Directory -Path $nodeDir,$gccDir,$plainDir | Out-Null
  New-Item -ItemType File -Path (Join-Path $nodeDir 'node.exe'),(Join-Path $nodeDir 'npm.cmd'),(Join-Path $gccDir 'gcc.exe'),(Join-Path $plainDir 'git.exe') | Out-Null
  $result=Split-HostToolchainPath "$nodeDir;;$plainDir;$gccDir;$(Join-Path $pathRoot 'missing');Q:\no-such-drive" @('npm','gcc','node')
  if(($result.hidden -join '|') -ne "$nodeDir|$gccDir"){throw 'Toolchain PATH entries not hidden'}
  if(($result.kept -join '|') -ne "$plainDir|$(Join-Path $pathRoot 'missing')|Q:\no-such-drive"){throw 'Plain PATH entries not kept in order'}
} finally {Remove-Item -LiteralPath $pathRoot -Recurse -Force -ErrorAction SilentlyContinue}
# Mock only the machine boundary; exercise the shared installer without servicing this host.
. (Join-Path $PSScriptRoot 'windows-ssh-capability.ps1')
function Assert-IsolatedWindowsSshCi([string]$Arch){if($script:refuseCapabilityHost){throw 'Injected host refusal'}}
function Assert-WindowsSshGlobalServerDormant([string]$Server){$script:globalChecks++;if($script:globalChecks -eq $script:refuseGlobalCheck){throw 'Injected global server refusal'}}
function Assert-WindowsSshStockShell {$script:shellChecks++;if($script:shellChecks -eq $script:refuseShellCheck){throw 'Injected shell refusal'}}
function Get-WindowsCapability([switch]$Online,[string]$Name){$script:capabilityQueries++;return @{State=$script:capabilityState}}
function Add-WindowsCapability([switch]$Online,[string]$Name){$script:capabilityAdds++;if($script:failCapabilityInstall){throw 'Injected capability install failure'}}
function Reset-CapabilityControl([string]$State){
  $script:capabilityState=$State;$script:capabilityQueries=0;$script:capabilityAdds=0
  $script:globalChecks=0;$script:shellChecks=0;$script:refuseGlobalCheck=0;$script:refuseShellCheck=0
  $script:refuseCapabilityHost=$false;$script:failCapabilityInstall=$false
  $script:capabilityStages=[Collections.Generic.List[string]]::new()
}
foreach($state in @('Installed','NotPresent')){
  Reset-CapabilityControl $state
  $capabilityReport=@{}
  Install-WindowsInboxSshCapability 'x64' $capabilityReport {param($name) $script:capabilityStages.Add($name)}
  $expectedAdds=if($state -eq 'Installed'){0}else{1}
  if($capabilityReport.inboxCapabilityInitialState -ne $state -or $script:capabilityAdds -ne $expectedAdds -or $script:globalChecks -ne 2 -or $script:shellChecks -ne 2 -or ($script:capabilityStages -join ',') -ne 'inbox-capability-start,inbox-capability-complete'){throw 'Shared capability preparation did not preserve the install and guard boundaries'}
}
foreach($fault in @('host','global-before','shell-before','global-after','shell-after','install')){
  Reset-CapabilityControl 'NotPresent'
  switch($fault){
    'host' {$script:refuseCapabilityHost=$true}
    'global-before' {$script:refuseGlobalCheck=1}
    'shell-before' {$script:refuseShellCheck=1}
    'global-after' {$script:refuseGlobalCheck=2}
    'shell-after' {$script:refuseShellCheck=2}
    'install' {$script:failCapabilityInstall=$true}
  }
  $rejected=$false
  try {Install-WindowsInboxSshCapability 'x64' @{} {param($name) $script:capabilityStages.Add($name)}} catch {$rejected=$true}
  if(-not $rejected -or $script:capabilityStages.Contains('inbox-capability-complete')){throw "Capability fault did not fail closed: $fault"}
  if($fault -in @('host','global-before','shell-before') -and $script:capabilityAdds){throw 'Capability mutation preceded its host guards'}
}
$capabilityRoot=Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString('N'))
try {
  New-Item -ItemType Directory -Path $capabilityRoot | Out-Null
  $capabilityReceipt=Join-Path $capabilityRoot 'capability.json'
  Reset-CapabilityControl 'Installed'
  Initialize-WindowsInboxSshCapability 'x64' $capabilityReceipt
  $completed=Get-Content -LiteralPath $capabilityReceipt -Raw | ConvertFrom-Json
  if($completed.status -ne 'passed' -or $completed.inboxCapabilityInitialState -ne 'Installed'){throw 'Capability success receipt missing its observed initial state'}
  Reset-CapabilityControl 'NotPresent';$script:failCapabilityInstall=$true
  $rejected=$false
  try {Initialize-WindowsInboxSshCapability 'x64' $capabilityReceipt} catch {$rejected=$true}
  $failed=Get-Content -LiteralPath $capabilityReceipt -Raw | ConvertFrom-Json
  if(-not $rejected -or $failed.status -ne 'failed' -or $failed.inboxCapabilityInitialState -ne 'NotPresent' -or $failed.error -ne 'Injected capability install failure'){throw 'Failed capability preparation masqueraded as a passing receipt'}
} finally {Remove-Item -LiteralPath $capabilityRoot -Recurse -Force -ErrorAction SilentlyContinue}
& {
  param($ProofAst)
  $cleanup=@($ProofAst.FindAll({param($node) $node -is [Management.Automation.Language.TryStatementAst] -and $node.Body.Extent.Text.Contains("Write-Stage 'cleanup-start'")},$true))
  if($cleanup.Count -ne 1 -or -not $cleanup[0].Extent.Text.Contains('[Diagnostics.Stopwatch]::StartNew()')){throw 'Cleanup clock boundary missing'}
  # Run the real cleanup gates with virtual clocks; no Windows machine operation may escape these mocks.
  $cleanupBlock=[scriptblock]::Create($cleanup[0].Extent.Text.Replace('[Diagnostics.Stopwatch]::StartNew()','(New-ProfileControlStopwatch)').Replace('[DateTime]::UtcNow','(Get-ProfileControlUtcNow)'))
  $ownedSids=@('S-1-5-21-100-200-300-1001','S-1-5-21-100-200-300-1002','S-1-5-21-100-200-300-1003')
  $foreignSid='S-1-5-21-100-200-300-9000';$control=@{}
  function New-ProfileControlStopwatch {
    $watch=[pscustomobject]@{StartedMilliseconds=$control.clockMs;Control=$control}
    $watch | Add-Member ScriptProperty ElapsedMilliseconds {$this.Control.clockMs-$this.StartedMilliseconds}
    return $watch
  }
  function Get-ProfileControlUtcNow {[DateTime]::new(2026,10,2,0,0,0,[DateTimeKind]::Utc).AddMilliseconds($control.clockMs)}
  function Start-Sleep([int]$Milliseconds,[int]$Seconds){$control.clockMs+=$Milliseconds+1000*$Seconds}
  function Write-Stage([string]$Stage){$control.stages.Add($Stage)}
  function Record-PrivateServiceDiagnostics([switch]$AfterStop){}
  function Test-Path([string]$LiteralPath){if($LiteralPath -ne 'HKLM:\SOFTWARE\OpenSSH'){throw 'Unexpected filesystem query'};return $false}
  function Get-ItemProperty([string]$LiteralPath,[object]$ErrorAction){if($LiteralPath -ne 'HKLM:\SOFTWARE\OpenSSH'){throw 'Unexpected registry query'};return $null}
  function Remove-ItemProperty {throw 'Unexpected registry mutation'}
  function Stop-Service([string]$Name,[switch]$Force,[object]$ErrorAction){if($Name -ne 'orca-sshd-control'){throw 'Foreign service stop'};if($control.case.Fault -ne 'server-exit'){$control.serverLive=$false}}
  function Invoke-Bounded([string]$Program,[string[]]$Arguments){if($Program -ne 'sc.exe' -or ($Arguments -join '|') -ne 'delete|orca-sshd-control'){throw 'Unexpected native command'};if($control.case.Fault -ne 'service-absence'){$control.servicePresent=$false}}
  function Get-Process([int]$Id,[object]$ErrorAction){if($Id -ne 100){throw 'Foreign process query'};if($control.serverLive){@{Id=100}}}
  function Get-Service([string]$Name,[object]$ErrorAction){if($Name -ne 'orca-sshd-control'){throw 'Foreign service query'};if($control.servicePresent){@{Name=$Name}}}
  function Get-ProfileControlLoaded([string]$Sid){
    $state=$control.profiles[$Sid]
    if($state.Mode -eq 'late'){return $control.clockMs -lt $state.UnloadAtMs}
    if($state.Mode -in @('reload','reload-at-deadline')){return $state.CurrentLoaded}
    return $state.Mode -eq 'loaded'
  }
  function Get-CimInstance([Parameter(Position=0)][string]$ClassName,[string]$Filter){
    if($ClassName -eq 'Win32_Service'){
      if($Filter -ne "Name='orca-sshd-control'"){throw 'Foreign service query'}
      if($control.servicePresent){@{PathName=$(if($control.case.Fault -eq 'service-identity'){'C:\foreign\sshd.exe'}else{'C:\fake\ossh-control\sshd.exe'});ProcessId=$(if($control.case.Fault -eq 'service-pid'){200}else{100})}};return
    }
    if($ClassName -eq 'Win32_Process'){
      if($control.case.Fault -eq 'child-exit'){@{ExecutablePath='C:\fake\OpenSSH\session.exe';ProcessId=101;ParentProcessId=100;CreationDate=(Get-ProfileControlUtcNow)}};return
    }
    if($ClassName -ne 'Win32_UserProfile' -or $Filter -notmatch "^SID='(S-1-5-21-100-200-300-\d+)'$" -or $Matches[1] -notin $ownedSids){throw 'Profile query must target an owned SID'}
    $sid=$Matches[1];$control.clockMs+=$control.case.QueryCostMs;$control.profileQueries[$sid]++
    if($control.case.Fault -eq 'query' -and $sid -eq $ownedSids[1]){throw 'Injected profile query failure'}
    if($control.case.Fault -eq 'foreign-result' -and $sid -eq $ownedSids[1]){[pscustomobject]@{SID=$foreignSid;Loaded=$false;Status=0};return}
    $state=$control.profiles[$sid]
    if($state.Mode -eq 'absent' -or $state.Deleted){return}
    $loaded=Get-ProfileControlLoaded $sid
    if($state.Mode -eq 'reload' -and $control.profileQueries[$sid] -eq 1){$loaded=$false;$state.CurrentLoaded=$true}
    if($state.Mode -eq 'reload-at-deadline' -and $control.clockMs -ge 30000 -and -not $state.Reinjected){$loaded=$false;$state.CurrentLoaded=$true;$state.Reinjected=$true}
    [pscustomobject]@{SID=$sid;Loaded=$loaded;Status=0}
  }
  function Remove-CimInstance {
    param([Parameter(ValueFromPipeline=$true)][object]$InputObject)
    process {
      if($InputObject.SID -notin $ownedSids -or $InputObject.Loaded -or (Get-ProfileControlLoaded $InputObject.SID)){throw 'Unsafe profile deletion attempted'}
      if($control.case.Fault -eq 'delete'){throw 'Injected profile deletion failure'}
      $control.profiles[$InputObject.SID].Deleted=$true;$control.removed.Add($InputObject.SID)
    }
  }
  function Get-LocalUser([string]$Name,[object]$ErrorAction){if(-not $control.users.ContainsKey($Name)){throw 'Foreign account query'};if($control.users[$Name]){@{Name=$Name}}}
  function Remove-LocalUser([string]$Name){if(-not $control.users.ContainsKey($Name)){throw 'Foreign account deletion'};if($control.case.Fault -ne 'account'){$control.users[$Name]=$false}}
  function Remove-Item([string]$LiteralPath,[switch]$Recurse,[switch]$Force){if($LiteralPath -ne 'C:\fake\ossh-control'){throw 'Foreign filesystem deletion'};if($control.case.Fault -eq 'keys'){throw 'Injected private key deletion failure'};$control.keysRemoved=$true}
  function Assert-ProfileCleanup([hashtable]$Case){
    $control.Clear();$control.case=$Case;$control.clockMs=0;$control.serverLive=$true;$control.servicePresent=$true;$control.keysRemoved=$false
    $control.stages=[Collections.Generic.List[string]]::new();$control.removed=[Collections.Generic.List[string]]::new()
    $control.profiles=@{};$control.users=@{};$control.profileQueries=@{}
    $ownedAccounts=@(for($index=0;$index -lt $ownedSids.Count;$index++){
      $sid=$ownedSids[$index];$control.profileQueries[$sid]=0
      $control.profiles[$sid]=@{Mode=$Case.Modes[$index];UnloadAtMs=$Case.UnloadAtMs[$index];CurrentLoaded=$true;Deleted=$false}
      $name="orca-control-$index";$control.users[$name]=$true;@{name=$name;sid=$(if($Case.MissingSid -and $index -eq 2){$null}else{$sid})}
    })
    $report=@{status='proof-passed-cleanup-pending'};$openSshKey='HKLM:\SOFTWARE\OpenSSH';$serviceName='orca-sshd-control'
    $root='C:\fake\ossh-control';$createdService=$true;$ownedServerPid=100;$sshDir='C:\fake\OpenSSH';$preexisting=@();$deniedToolDirs=@()
    & $cleanupBlock
    if($Case.Fault){
      if($report.status -ne 'failed' -or $report.cleanupError -ne $Case.Error -or $control.keysRemoved -or $control.stages.Contains('cleanup-private-files-complete')){throw "Cleanup fault did not fail at its gate: $($Case.Name)"}
      if($Case.Fault -notin @('account','keys') -and @($control.users.Values | Where-Object {-not $_}).Count){throw "Failure bypassed account cleanup gate: $($Case.Name)"}
      return
    }
    if($report.status -ne 'passed' -or @($control.users.Values | Where-Object {$_}).Count -or -not $control.keysRemoved){throw "Cleanup omitted account/key gates: $($Case.Name)"}
    if(($control.removed.ToArray() | Sort-Object) -join ',' -ne (($Case.Removed | Sort-Object) -join ',')){throw "Wrong removed SIDs: $($Case.Name)"}
    if(@($report.profileCleanup | Where-Object {$_ -eq 'Loaded profile retained for disposable CI VM destruction'}).Count -ne $Case.Retained){throw "Wrong retained disposition: $($Case.Name)"}
    foreach($sid in $Case.FullWindow){
      $observed=@($report.privateProfiles | Where-Object sid -eq $sid)
      if($observed.Count -ne 1 -or $observed[0].waitMs -lt 30000){throw "Short profile observation window: $($Case.Name)"}
    }
    if($control.clockMs -gt $Case.MaxClockMs){throw "Profile windows were serialized: $($Case.Name)"}
    if($Case.MissingSid -and $control.profileQueries[$ownedSids[2]]){throw 'Missing SID gained profile deletion authority'}
    if($report.privateProfiles.Count -and ($report.profileUnloadWaitMs -ne $report.privateProfiles[-1].waitMs -or ($report.privateProfile | ConvertTo-Json -Compress) -ne ($report.privateProfiles[-1].profiles | ConvertTo-Json -Compress))){throw 'Legacy scalar observation lost owned-account order'}
  }
  $cases=@(
    @{Name='three loaded full windows';Modes=@('loaded','loaded','loaded');Retained=3;Removed=@();FullWindow=$ownedSids},
    @{Name='unload at 29999ms';Modes=@('late','unloaded','absent');UnloadAtMs=@(29999,0,0);Retained=0;Removed=$ownedSids[0..1];FullWindow=@($ownedSids[0])},
    @{Name='reload before deletion';Modes=@('reload','unloaded','absent');Retained=1;Removed=@($ownedSids[1]);FullWindow=@($ownedSids[0])},
    @{Name='independent unloads';Modes=@('late','loaded','late');UnloadAtMs=@(5000,0,20000);Retained=1;Removed=@($ownedSids[0],$ownedSids[2]);FullWindow=@($ownedSids[1])},
    @{Name='slow provider queries';Modes=@('loaded','loaded','loaded');QueryCostMs=200;Retained=3;Removed=@();FullWindow=$ownedSids;MaxClockMs=40000},
    @{Name='reload at expired window';Modes=@('reload-at-deadline','unloaded','absent');Retained=1;Removed=@($ownedSids[1]);FullWindow=@($ownedSids[0])},
    @{Name='late unload honestly retained';Modes=@('loaded','loaded','late');UnloadAtMs=@(0,0,45000);Retained=3;Removed=@();FullWindow=$ownedSids},
    @{Name='missing SID is skipped';Modes=@('unloaded','absent','unloaded');Retained=0;Removed=@($ownedSids[0]);MissingSid=$true}
  )
  foreach($case in $cases){
    if(-not $case.UnloadAtMs){$case.UnloadAtMs=@(0,0,0)}
    if(-not $case.MaxClockMs){$case.MaxClockMs=33000}
    Assert-ProfileCleanup $case
  }
  $failures=@{
    query='Injected profile query failure';delete='Injected profile deletion failure';'foreign-result'='Private profile query returned an unrelated SID'
    'service-identity'='Private service identity changed; refuse stop';'service-pid'='Private service identity changed; refuse stop'
    'server-exit'='Private sshd process still live; no PID-only kill attempted'
    'service-absence'='Private service still registered';'child-exit'='Private SSH child processes remain; preserve files and discard ephemeral runner'
    account='Private account still exists';keys='Injected private key deletion failure'
  }
  foreach($failure in $failures.GetEnumerator()){Assert-ProfileCleanup @{Name=$failure.Key;Fault=$failure.Key;Error=$failure.Value;Modes=@('unloaded','unloaded','unloaded');UnloadAtMs=@(0,0,0)}}
} $ast
# Extract functions through the AST: never provision the fixture while testing diagnostics.
'PASS: fixture parse, diagnostics, PATH split, capability boundaries, profile windows and cleanup failure gates'
