# Ephemeral CI only. Runs each Windows host cell (src/main/ssh/ssh-windows-host-cells.ts) against the
# private sshd prove-preview-openssh.ps1 provisioned: one account, one DefaultShell and one vitest
# process per cell, so every cell starts from an empty runtime store.
param(
 [Parameter(Mandatory=$true)][string]$SourceRoot,
 [Parameter(Mandatory=$true)][hashtable]$Context,
 [Parameter(Mandatory=$true)][ValidateSet('win32-arm64','win32-x64')][string]$Target,
 [Parameter(Mandatory=$true)][string]$ReceiptRoot,
 [ValidateSet('pinned-cmd','pinned-powershell','legacy-opt-out','orcad-cmd','orcad-powershell','orcad-convert')][string[]]$Cells=@('pinned-cmd','pinned-powershell','legacy-opt-out','orcad-cmd','orcad-powershell')
)
$ErrorActionPreference='Stop'
if($env:GITHUB_ACTIONS -ne 'true' -or $env:ORCA_ISOLATED_SSH_CI -ne '1'){throw 'Disposable CI only'}
$shells=@{'pinned-cmd'='cmd';'pinned-powershell'='powershell';'legacy-opt-out'='cmd';'orcad-cmd'='cmd';'orcad-powershell'='powershell';'orcad-convert'='cmd'}
if($Context.accounts.Count -lt $Cells.Count){throw 'Each cell needs its own private account'}
if(-not $Context.forbiddenToolLog){throw 'Run the provisioning with -HiddenTools so toolchain calls are logged'}
$openSshKey='HKLM:\SOFTWARE\OpenSSH'
$windowsPowerShell=Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
$knownPath=Join-Path ([Environment]::GetFolderPath('UserProfile')) '.ssh\known_hosts'
$knownExisted=Test-Path -LiteralPath $knownPath
$priorKnown=if($knownExisted){[IO.File]::ReadAllBytes($knownPath)}else{$null}
$priorBackground=$env:ORCA_BACKGROUND_LAUNCH
$failed=[Collections.Generic.List[string]]::new()
$summary=[Collections.Generic.List[hashtable]]::new()

function Invoke-PrivateSsh([string]$Account,[string]$Command) {
  $start=[Diagnostics.ProcessStartInfo]::new($Context.sshExe)
  $start.UseShellExecute=$false;$start.CreateNoWindow=$true;$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
  foreach($argument in @('-F','NUL','-T','-p',[string]$Context.port,'-i',$Context.identityFile,'-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','StrictHostKeyChecking=yes','-o',"UserKnownHostsFile=$($Context.knownHosts)",'-o','ConnectTimeout=5',"$Account@127.0.0.1",$Command)){$start.ArgumentList.Add($argument)}
  $process=[Diagnostics.Process]::Start($start)
  try {
    $stdout=$process.StandardOutput.ReadToEndAsync();$null=$process.StandardError.ReadToEndAsync()
    if(-not $process.WaitForExit(30000)){$process.Kill($true);throw 'Private SSH probe deadline exceeded'}
    return $stdout.GetAwaiter().GetResult()
  } finally {$process.Dispose()}
}

function Set-PrivateDefaultShell([string]$Shell) {
  if($Shell -eq 'powershell'){
    if(-not (Test-Path -LiteralPath $openSshKey)){New-Item -Path $openSshKey -Force | Out-Null}
    New-ItemProperty -LiteralPath $openSshKey -Name DefaultShell -Value $windowsPowerShell -PropertyType String -Force | Out-Null
  } elseif(Test-Path -LiteralPath $openSshKey) {
    Remove-ItemProperty -LiteralPath $openSshKey -Name DefaultShell -ErrorAction SilentlyContinue
  }
}

# Diagnostic only: Orca must launch the relay without WMI, which refuses a standard user's SSH
# (network) logon unless an administrator grants Remote Enable on root\cimv2. The cells run with no
# such grant, so a relay launch that still needs WMI fails its cell. Prints ORCA_WMI=<ReturnValue>
# or ORCA_WMI=denied.
function Test-PrivateWmiLaunch([string]$Account) {
  $out=Invoke-PrivateSsh $Account 'powershell.exe -NoProfile -NonInteractive -Command "try{$r=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=''cmd.exe /d /c exit 0''} -ErrorAction Stop;''ORCA_WMI=''+$r.ReturnValue}catch{''ORCA_WMI=denied''}"'
  $match=[regex]::Match($out,'ORCA_WMI=(\S+)')
  if($match.Success){return $match.Groups[1].Value}else{return 'no-output'}
}

# The app converts a relay-era host on connect (tests/e2e/ssh-orcad-auto-convert.spec.ts). Last in
# the run: it switches native modules to Electron's ABI, which the vitest cells cannot load.
function Invoke-ConvertCell($Account,[string]$Descriptor,[string]$Log) {
  $ready=Invoke-PrivateSsh $Account.name 'git init -q orca-convert-repo && git -C orca-convert-repo -c user.name=orca -c user.email=orca@example.invalid commit -q --allow-empty -m init && echo ORCA_REPO_READY'
  if($ready -notmatch 'ORCA_REPO_READY'){throw 'Could not create the convert cell repository as the account'}
  # Out of the app's default lookup, so the relay phase runs without a template.
  $template=Join-Path $env:RUNNER_TEMP 'orcad-convert-template'
  Copy-Item -LiteralPath 'out\orcad-template' -Destination $template -Recurse -Force
  Rename-Item -LiteralPath 'out\orcad-template' -NewName 'orcad-template.convert-hidden'
  try {
    & node config/scripts/ensure-native-runtime.mjs --runtime=electron 2>&1 | Tee-Object -FilePath $Log | Out-Host
    & pnpm exec electron-vite build --mode e2e 2>&1 | Tee-Object -FilePath $Log -Append | Out-Host
    $env:ORCA_E2E_ORCAD_CONVERT_HOST=$Descriptor;$env:ORCA_E2E_ORCAD_CONVERT_TEMPLATE=$template;$env:SKIP_BUILD='1'
    & pnpm exec playwright test --config tests/playwright.config.ts tests/e2e/ssh-orcad-auto-convert.spec.ts --project=electron-headless --workers=1 2>&1 | Tee-Object -FilePath $Log -Append | Out-Host
    # Functions return uncaptured output, so only the exit code may reach the caller.
    return $global:LASTEXITCODE
  } finally {
    Remove-Item Env:ORCA_E2E_ORCAD_CONVERT_HOST,Env:ORCA_E2E_ORCAD_CONVERT_TEMPLATE,Env:SKIP_BUILD -ErrorAction SilentlyContinue
    Rename-Item -LiteralPath 'out\orcad-template.convert-hidden' -NewName 'orcad-template'
  }
}

New-Item -ItemType Directory -Force -Path $ReceiptRoot | Out-Null
Push-Location $SourceRoot
try {
  if(-not (Test-Path -LiteralPath "out\relay\$Target\relay.js")){throw 'Build the relay before provisioning'}
  if(-not (Test-Path -LiteralPath 'out\orcad-template')){throw 'Build the orcad template before provisioning'}
  # ssh2 consults the runner's known_hosts: pin only this private endpoint, restored below.
  New-Item -ItemType Directory -Force -Path (Split-Path $knownPath) | Out-Null
  Add-Content -LiteralPath $knownPath -Value ("`n"+[IO.File]::ReadAllText($Context.knownHosts))
  $env:ORCA_BACKGROUND_LAUNCH='1'
  # DefaultShell is still stock cmd here.
  $wmi=Test-PrivateWmiLaunch $Context.accounts[0].name
  Write-Host "Standard SSH user WMI Win32_Process.Create: $wmi (no grant; the relay launch must not depend on it)"
  $summary.Add(@{standardUserWmiLaunch=$wmi;granted=$false})
  for($index=0;$index -lt $Cells.Count;$index++){
    $cell=$Cells[$index];$account=$Context.accounts[$index];$shell=$shells[$cell]
    Set-PrivateDefaultShell $shell
    # cmd expands %COMSPEC%; PowerShell prints it literally.
    $dispatch=Invoke-PrivateSsh $account.name 'echo %COMSPEC%'
    $dispatchShell=if($dispatch -match '(?i)\\cmd\.exe'){'cmd'}elseif($dispatch -match '%COMSPEC%'){'powershell'}else{'unknown'}
    if($dispatchShell -ne $shell){throw "DefaultShell $shell did not take effect for $cell (saw $dispatchShell)"}
    if(Test-Path -LiteralPath $Context.forbiddenToolLog){Move-Item -LiteralPath $Context.forbiddenToolLog -Destination (Join-Path $ReceiptRoot "$cell.before.forbidden-tool-calls.log")}
    $descriptor=Join-Path $ReceiptRoot "$cell.descriptor.json"
    @{cell=$cell;target=$Target;host='127.0.0.1';port=[int]$Context.port;username=$account.name;identityFile=$Context.identityFile;home=$account.home;forbiddenToolLog=$Context.forbiddenToolLog;receipt=(Join-Path $ReceiptRoot "$cell.json")} | ConvertTo-Json | Set-Content -LiteralPath $descriptor -Encoding utf8NoBOM
    $env:ORCA_RUN_SSH_WINDOWS_HOST='1';$env:ORCA_SSH_WINDOWS_HOST_CELL=$descriptor
    Write-Host "Windows host cell $cell ($Target, DefaultShell $shell, account $($account.name))"
    if($cell -eq 'orcad-convert'){
      $code=Invoke-ConvertCell $account $descriptor (Join-Path $ReceiptRoot "$cell.log")
    } else {
      # orcad cells deploy managed orcad instead of the relay; same account and descriptor shape.
      $lane=if($cell.StartsWith('orcad-')){'src/main/ssh/orcad-windows-host-lane.test.ts'}else{'src/main/ssh/ssh-relay-windows-host-lane.test.ts'}
      & node node_modules/vitest/vitest.mjs run --config config/vitest.config.ts $lane --reporter=verbose 2>&1 | Tee-Object -FilePath (Join-Path $ReceiptRoot "$cell.log")
      # Why global: under the workflow's GetNewClosure callback, bare $LASTEXITCODE reads a stale captured copy.
      $code=$global:LASTEXITCODE
    }
    # The relay's own log is the only record of why it closed a client.
    foreach($log in @(Get-ChildItem -Path (Join-Path $account.home '.orca-remote\relay-*\relay*.log'),(Join-Path $account.home '.orca-remote\orcad-*\orcad.log') -File -ErrorAction SilentlyContinue)){Copy-Item -LiteralPath $log.FullName -Destination (Join-Path $ReceiptRoot "$cell.$($log.Directory.Name).$($log.Name)")}
    if(Test-Path -LiteralPath $Context.forbiddenToolLog){Copy-Item -LiteralPath $Context.forbiddenToolLog -Destination (Join-Path $ReceiptRoot "$cell.forbidden-tool-calls.log")}
    $summary.Add(@{cell=$cell;shell=$shell;account=$account.name;exitCode=$code})
    if($code -ne 0){$failed.Add($cell)}
  }
  # Relays outlive their client by a 60s grace; wait so cleanup can unload the profiles.
  $homes=@($Context.accounts | ForEach-Object {$_.home.TrimEnd('\')+'\'})
  $graceDeadline=[DateTime]::UtcNow.AddSeconds(120)
  do {
    $relays=@(Get-CimInstance Win32_Process | Where-Object {$path=$_.ExecutablePath;$path -and @($homes | Where-Object {$path.StartsWith($_,[StringComparison]::OrdinalIgnoreCase)}).Count})
    if(-not $relays.Count){break};Start-Sleep -Seconds 2
  } while([DateTime]::UtcNow -lt $graceDeadline)
  $summary.Add(@{relayProcessesAfterGrace=@($relays | ForEach-Object {[IO.Path]::GetFileName($_.ExecutablePath)})})
} finally {
  Set-PrivateDefaultShell 'cmd'
  if($knownExisted){[IO.File]::WriteAllBytes($knownPath,$priorKnown)}else{Remove-Item -LiteralPath $knownPath -Force -ErrorAction SilentlyContinue}
  $env:ORCA_BACKGROUND_LAUNCH=$priorBackground
  Remove-Item Env:ORCA_RUN_SSH_WINDOWS_HOST,Env:ORCA_SSH_WINDOWS_HOST_CELL -ErrorAction SilentlyContinue
  $summary | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $ReceiptRoot 'summary.json') -Encoding utf8NoBOM
  Pop-Location
}
if($failed.Count){throw "Windows host cells failed: $($failed -join ', ')"}
