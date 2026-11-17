<#
.SYNOPSIS
  Prepares this Windows machine as an always-on Zotz node reachable only over Tailscale.

.DESCRIPTION
  Idempotent: every step checks the current state first, so running it again changes nothing
  that is already right. Requires an elevated PowerShell. Never asks for or stores a password.

  Steps (each prints what it did and is reported in -ResultPath as done / skipped / failed):
    power          No sleep or hibernate on AC power; closing the lid on AC does nothing.
    windowsUpdate  Active hours policy and no automatic restart while a user is signed in.
    ssh            OpenSSH Server installed, automatic, key-only (PasswordAuthentication no).
    firewall       Inbound TCP to the Zotz port and SSH only from the Tailscale range.
    autostart      Registers the Zotz logon task from -TaskXmlPath (written by the Zotz app).

  Not automated on purpose: automatic sign-in (use Sysinternals Autologon, which stores the
  password as an LSA secret) and the BIOS "Restore on AC Power Loss" option.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy RemoteSigned -File zotz-node-setup.ps1 -Port 6768
#>
[CmdletBinding()]
param(
    [ValidateRange(1, 65535)]
    [int]$Port = 6768,
    [ValidateRange(1, 65535)]
    [int]$SshPort = 22,
    [string]$TailnetRange = '100.64.0.0/10',
    # Windows caps active hours at 18; outside them updates may restart only when nobody is signed in.
    [ValidateRange(0, 23)]
    [int]$ActiveHoursStart = 6,
    [ValidateRange(0, 23)]
    [int]$ActiveHoursEnd = 0,
    [string]$TaskXmlPath = '',
    # Zotz.exe; its inbound Block rules (a dismissed "Allow access" prompt) outrank any Allow.
    [string]$AppPath = '',
    [string]$TaskName = '\Zotz\Server',
    [string]$ResultPath = '',
    # A transcript, because the wizard runs this elevated in a hidden window.
    [string]$LogPath = '',
    [switch]$SkipSsh
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$script:Results = [ordered]@{}
if ($LogPath) {
    try { Start-Transcript -LiteralPath $LogPath -Force | Out-Null } catch {}
}

function Write-Step([string]$Message) {
    Write-Host "[zotz] $Message"
}

function Set-StepResult([string]$Id, [string]$Status, [string]$Detail) {
    $script:Results[$Id] = [ordered]@{ id = $Id; status = $Status; detail = $Detail }
    Write-Step "$Id -> $Status$(if ($Detail) { ": $Detail" })"
}

function Save-Results {
    if ($LogPath) {
        try { Stop-Transcript | Out-Null } catch {}
    }
    if (-not $ResultPath) { return }
    $payload = [ordered]@{ version = 1; steps = @($script:Results.Values) }
    $json = $payload | ConvertTo-Json -Depth 4
    [System.IO.File]::WriteAllText($ResultPath, $json, (New-Object System.Text.UTF8Encoding $false))
}

function Invoke-Step([string]$Id, [scriptblock]$Body) {
    Write-Step "== $Id =="
    try {
        $detail = & $Body
        if ($detail -is [array]) { $detail = $detail[-1] }
        if ($detail -like 'skipped:*') {
            Set-StepResult $Id 'skipped' ($detail.Substring(8).Trim())
        } else {
            Set-StepResult $Id 'done' ([string]$detail)
        }
    } catch {
        Set-StepResult $Id 'failed' $_.Exception.Message
    }
}

function Invoke-Native([string]$FilePath, [string[]]$Arguments) {
    $output = & $FilePath @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "$FilePath $($Arguments -join ' ') exited $LASTEXITCODE`: $($output -join ' ')"
    }
}

function Set-RegistryDword([string]$Path, [string]$Name, [int]$Value) {
    if (-not (Test-Path -LiteralPath $Path)) {
        New-Item -Path $Path -Force | Out-Null
    }
    $current = Get-ItemProperty -LiteralPath $Path -Name $Name -ErrorAction SilentlyContinue
    if ($null -ne $current -and $current.$Name -eq $Value) {
        return $false
    }
    New-ItemProperty -LiteralPath $Path -Name $Name -PropertyType DWord -Value $Value -Force | Out-Null
    return $true
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin = (New-Object Security.Principal.WindowsPrincipal $identity).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    foreach ($id in @('power', 'windowsUpdate', 'ssh', 'firewall', 'autostart')) {
        Set-StepResult $id 'failed' 'requires an elevated (administrator) PowerShell'
    }
    Save-Results
    exit 1
}

$powercfg = Join-Path $env:SystemRoot 'System32\powercfg.exe'
$schtasks = Join-Path $env:SystemRoot 'System32\schtasks.exe'

Invoke-Step 'power' {
    Invoke-Native $powercfg @('/change', 'standby-timeout-ac', '0')
    Invoke-Native $powercfg @('/change', 'hibernate-timeout-ac', '0')
    # LIDACTION 0 = Do nothing; laptops without a lid simply ignore the setting.
    Invoke-Native $powercfg @('/setacvalueindex', 'SCHEME_CURRENT', 'SUB_BUTTONS', 'LIDACTION', '0')
    Invoke-Native $powercfg @('/setactive', 'SCHEME_CURRENT')
    'AC: sleep never, hibernate never, lid does nothing'
}

Invoke-Step 'windowsUpdate' {
    $wu = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate'
    $au = Join-Path $wu 'AU'
    $changed = @(
        (Set-RegistryDword $wu 'SetActiveHours' 1),
        (Set-RegistryDword $wu 'ActiveHoursStart' $ActiveHoursStart),
        (Set-RegistryDword $wu 'ActiveHoursEnd' $ActiveHoursEnd),
        (Set-RegistryDword $au 'NoAutoRebootWithLoggedOnUsers' 1)
    ) -contains $true
    $summary = "active hours ${ActiveHoursStart}:00-${ActiveHoursEnd}:00, no auto-restart while signed in"
    if ($changed) { $summary } else { "already set ($summary)" }
}

Invoke-Step 'ssh' {
    if ($SkipSsh) { return 'skipped: -SkipSsh' }
    $capability = Get-WindowsCapability -Online -Name 'OpenSSH.Server*' | Select-Object -First 1
    if ($null -eq $capability) { throw 'OpenSSH.Server is not offered by this Windows edition' }
    if ($capability.State -ne 'Installed') {
        Write-Step 'installing OpenSSH Server (this can take a few minutes)'
        Add-WindowsCapability -Online -Name $capability.Name | Out-Null
    }
    $config = Join-Path $env:ProgramData 'ssh\sshd_config'
    if (-not (Test-Path -LiteralPath $config)) {
        # sshd writes its default config on first start.
        Start-Service sshd
        Stop-Service sshd
    }
    $lines = @(Get-Content -LiteralPath $config)
    $wanted = @('PasswordAuthentication no', 'PubkeyAuthentication yes')
    $kept = @($lines | Where-Object { $_ -notmatch '^\s*#?\s*(PasswordAuthentication|PubkeyAuthentication)\b' })
    # sshd keeps the first value it reads, and lines after a Match block are scoped to it; prepend.
    $next = @($wanted + $kept)
    if (($next -join "`n") -ne ($lines -join "`n")) {
        Set-Content -LiteralPath $config -Value $next -Encoding ascii
        $configChanged = $true
    }
    Set-Service -Name sshd -StartupType Automatic
    if ((Get-Service sshd).Status -ne 'Running') {
        Start-Service sshd
    } elseif ($configChanged) {
        Restart-Service sshd
    }
    $adminKeys = Join-Path $env:ProgramData 'ssh\administrators_authorized_keys'
    $userKeys = Join-Path $env:USERPROFILE '.ssh\authorized_keys'
    if (-not (Test-Path -LiteralPath $adminKeys) -and -not (Test-Path -LiteralPath $userKeys)) {
        return 'sshd running key-only, but no authorized_keys yet: add your public key (see docs/zotz/NODE-SETUP.md)'
    }
    'sshd running, key-only'
}

Invoke-Step 'firewall' {
    $legacy = @(Get-NetFirewallRule -DisplayName 'Zotz (Tailscale)' -ErrorAction SilentlyContinue)
    $legacy | Remove-NetFirewallRule
    $rules = @(
        @{ Name = 'Zotz.Server.Tailnet'; DisplayName = 'Zotz server (Tailscale only)'; Port = $Port },
        @{ Name = 'Zotz.SSH.Tailnet'; DisplayName = 'Zotz SSH (Tailscale only)'; Port = $SshPort }
    )
    foreach ($rule in $rules) {
        Get-NetFirewallRule -Name $rule.Name -ErrorAction SilentlyContinue | Remove-NetFirewallRule
        New-NetFirewallRule -Name $rule.Name -DisplayName $rule.DisplayName -Direction Inbound `
            -Action Allow -Protocol TCP -LocalPort $rule.Port -RemoteAddress $TailnetRange `
            -Profile Any -Enabled True | Out-Null
    }
    if ($AppPath) {
        # Exact-app rules covering this port: Block rules go (as in Orca's mobile firewall repair), and
        # Allow rules from Windows' first-listen prompt are narrowed to the tailnet so LAN stays out.
        $appRules = @(Get-NetFirewallApplicationFilter -Program $AppPath -ErrorAction SilentlyContinue |
            Get-NetFirewallRule | Where-Object { $_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' })
        foreach ($rule in $appRules) {
            $portFilter = $rule | Get-NetFirewallPortFilter
            $ports = @($portFilter.LocalPort | ForEach-Object { [string]$_ })
            if (-not (($ports -contains 'Any') -or ($ports -contains [string]$Port))) { continue }
            if ($rule.Action -eq 'Block') {
                Write-Step "removing blocking rule '$($rule.DisplayName)'"
                $rule | Remove-NetFirewallRule
                continue
            }
            $addressFilter = $rule | Get-NetFirewallAddressFilter
            if (@($addressFilter.RemoteAddress) -contains 'Any') {
                Write-Step "limiting allow rule '$($rule.DisplayName)' to $TailnetRange"
                $addressFilter | Set-NetFirewallAddressFilter -RemoteAddress $TailnetRange
            }
        }
    }
    # OpenSSH's own rule admits port 22 from anywhere; the tailnet rule above replaces it.
    Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue |
        Set-NetFirewallRule -Enabled False
    "TCP $Port and $SshPort inbound only from $TailnetRange"
}

Invoke-Step 'autostart' {
    if (-not $TaskXmlPath) { return 'skipped: no -TaskXmlPath (the Zotz wizard passes one)' }
    if (-not (Test-Path -LiteralPath $TaskXmlPath)) { throw "task XML not found: $TaskXmlPath" }
    Invoke-Native $schtasks @('/Create', '/TN', $TaskName, '/XML', $TaskXmlPath, '/F')
    "task $TaskName registered (at logon, restarts every minute)"
}

Write-Step 'Not automated: automatic sign-in -> Sysinternals Autologon (https://learn.microsoft.com/sysinternals/downloads/autologon).'
Write-Step 'Not automated: enable "Restore on AC Power Loss" (or similar) in the BIOS/UEFI.'
Save-Results
$failed = @($script:Results.Values | Where-Object { $_.status -eq 'failed' }).Count
exit ([int]($failed -gt 0))
