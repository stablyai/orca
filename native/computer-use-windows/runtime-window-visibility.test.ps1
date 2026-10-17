$ErrorActionPreference = 'Stop'

# Extract only producer/visibility functions. Never dot-source the runtime, load UIA,
# compile its P/Invoke type, or call native window APIs in this regression test.
$runtimePath = Join-Path $PSScriptRoot 'runtime.ps1'
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($runtimePath, [ref]$tokens, [ref]$errors)
if ($errors.Count -ne 0) { throw 'runtime.ps1 failed PowerShell parse' }
$definitions = @{}
foreach ($name in @('Get-OrcaWindowList', 'Get-OrcaWindowVisibilityState')) {
    $found = @($ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true))
    if ($found.Count -gt 1 -or ($name -eq 'Get-OrcaWindowList' -and $found.Count -ne 1)) { throw "Expected one function $name" }
    if ($found.Count -eq 1) { $definitions[$name] = $found[0].Extent.Text; . ([scriptblock]::Create($found[0].Extent.Text)) }
}

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
public static class OrcaDesktopWin32 {
    public struct RECT { public int Left, Top, Right, Bottom; }
    public static readonly Queue<bool> Valid = new Queue<bool>();
    public static readonly Queue<int> Owners = new Queue<int>();
    public static readonly Queue<bool> Iconic = new Queue<bool>();
    public static readonly Queue<bool> RectSuccess = new Queue<bool>();
    public static readonly Queue<RECT> Rectangles = new Queue<RECT>();
    public static readonly Queue<long> Monitors = new Queue<long>();
    public static readonly List<string> Calls = new List<string>();
    public static string ThrowOn;
    private static T Read<T>(Queue<T> values, T fallback) { return values.Count == 0 ? fallback : values.Count == 1 ? values.Peek() : values.Dequeue(); }
    private static void Call(string name) { Calls.Add(name); if (name.StartsWith(ThrowOn ?? "never-match")) { throw new InvalidOperationException("fake native failure: " + name); } }
    public static bool IsWindow(IntPtr hwnd) { Call("IsWindow:" + hwnd.ToInt64()); return Read(Valid, true); }
    public static int GetWindowProcessId(IntPtr hwnd) { Call("GetWindowProcessId:" + hwnd.ToInt64()); return Read(Owners, 123); }
    public static bool IsIconic(IntPtr hwnd) { Call("IsIconic:" + hwnd.ToInt64()); return Read(Iconic, false); }
    public static bool GetWindowRect(IntPtr hwnd, out RECT rect) {
        Call("GetWindowRect:" + hwnd.ToInt64());
        rect = Read(Rectangles, new RECT { Left = 10, Top = 20, Right = 60, Bottom = 70 });
        return Read(RectSuccess, true);
    }
    public static IntPtr MonitorFromWindow(IntPtr hwnd, uint flags) { Call("MonitorFromWindow:" + hwnd.ToInt64() + ":" + flags); return new IntPtr(Read(Monitors, 0L)); }
    public static void Reset() { Valid.Clear(); Owners.Clear(); Iconic.Clear(); RectSuccess.Clear(); Rectangles.Clear(); Monitors.Clear(); Calls.Clear(); ThrowOn = null; }
}
'@

$script:testHandle = [IntPtr]501
$script:testProcessId = 123
function Find-OrcaProcess([string]$Query) { [pscustomobject]@{ Id = $script:testProcessId; ProcessName = 'FakeApp'; MainWindowTitle = 'test' } }
function Resolve-OrcaWindowHandle($Process) { $script:testHandle }
function Get-OrcaRootElement([IntPtr]$WindowHandle) { $null }
# Deliberately not native geometry. Visibility must not compare this frame with displays.
function Get-OrcaWindowFrame([IntPtr]$WindowHandle, $RootElement) { [pscustomobject]@{ x = 7; y = 9; width = 40; height = 50 } }
function New-OrcaAppRecord($Process) { [pscustomobject]@{ pid = $Process.Id; name = $Process.ProcessName } }
function Get-OrcaWindowId([IntPtr]$WindowHandle) { [int64]$WindowHandle }

function Assert-NullableBool($Actual, $Expected, [string]$Label) {
    if ($null -eq $Expected) {
        if ($null -ne $Actual) { throw "$Label expected null, received '$Actual'" }
    } elseif ($Actual -isnot [bool] -or $Actual -ne $Expected) { throw "$Label expected boolean '$Expected', received '$Actual'" }
}

$script:passed = @()
function Test-WindowState([string]$Name, [hashtable]$Setup, $Minimized, $Offscreen) {
    [OrcaDesktopWin32]::Reset(); $script:testHandle = [IntPtr]501; $script:testProcessId = 123
    foreach ($value in @($Setup.valid)) { if ($null -ne $value) { [OrcaDesktopWin32]::Valid.Enqueue([bool]$value) } }
    foreach ($value in @($Setup.owners)) { if ($null -ne $value) { [OrcaDesktopWin32]::Owners.Enqueue([int]$value) } }
    foreach ($value in @($Setup.iconic)) { if ($null -ne $value) { [OrcaDesktopWin32]::Iconic.Enqueue([bool]$value) } }
    foreach ($value in @($Setup.rectSuccess)) { if ($null -ne $value) { [OrcaDesktopWin32]::RectSuccess.Enqueue([bool]$value) } }
    foreach ($value in @($Setup.rectangles)) {
        if ($null -ne $value) { $rect = New-Object OrcaDesktopWin32+RECT; $rect.Left = $value[0]; $rect.Top = $value[1]; $rect.Right = $value[2]; $rect.Bottom = $value[3]; [OrcaDesktopWin32]::Rectangles.Enqueue($rect) }
    }
    foreach ($value in @($Setup.monitors)) { if ($null -ne $value) { [OrcaDesktopWin32]::Monitors.Enqueue([long]$value) } }
    if ($Setup.ContainsKey('throwOn')) { [OrcaDesktopWin32]::ThrowOn = $Setup.throwOn }
    if ($Setup.ContainsKey('handle')) { $script:testHandle = [IntPtr][long]$Setup.handle }
    if ($Setup.ContainsKey('pid')) { $script:testProcessId = $Setup.pid }
    $list = Get-OrcaWindowList 'pid:123'
    if ($list.windows.Count -ne 1) { throw "$Name did not publish exactly one existing window" }
    $row = $list.windows[0]
    Assert-NullableBool $row.isMinimized $Minimized "$Name isMinimized"
    Assert-NullableBool $row.isOffscreen $Offscreen "$Name isOffscreen"
    # Check published JSON booleans/null, not just PowerShell truthiness.
    $jsonRow = (($list | ConvertTo-Json -Depth 6 -Compress) | ConvertFrom-Json).windows[0]
    Assert-NullableBool $jsonRow.isMinimized $Minimized "$Name JSON isMinimized"
    Assert-NullableBool $jsonRow.isOffscreen $Offscreen "$Name JSON isOffscreen"
    if ($row.x -ne 7 -or $row.y -ne 9 -or $row.width -ne 40 -or $row.height -ne 50 -or $row.id -ne [int64]$script:testHandle) { throw "$Name changed existing frame/identity output" }
    $monitorCalls = @([OrcaDesktopWin32]::Calls | Where-Object { $_ -like 'MonitorFromWindow:*' })
    if (@($monitorCalls | Where-Object { $_ -ne 'MonitorFromWindow:501:0' }).Count -ne 0) { throw "$Name used a foreign HWND or monitor fallback flag" }
    if ($null -ne $Minimized -and $Minimized -and @([OrcaDesktopWin32]::Calls | Where-Object { $_ -like 'GetWindowRect:*' -or $_ -like 'MonitorFromWindow:*' }).Count -ne 0) { throw "$Name used pre-minimize geometry" }
    if ($null -ne $Minimized -and -not $Minimized -and $monitorCalls.Count -ne 2) { throw "$Name did not corroborate monitor classification" }
    $script:passed += $Name
}

try {
    # Baseline producer hardcodes false; this must fail before the fix, not skip.
    Test-WindowState 'offscreen nonminimized published true' @{ monitors = @(0, 0) } $false $true
    Test-WindowState 'intersecting monitor published false' @{ monitors = @(5, 5) } $false $false
    Test-WindowState 'minimized published true true without pre-minimize monitor' @{ iconic = @($true, $true); monitors = @(5, 5); rectSuccess = @($false) } $true $true
    Test-WindowState 'invalid handle nullable unknown' @{ valid = @($false) } $null $null
    Test-WindowState 'zero handle nullable unknown' @{ handle = 0 } $null $null
    Test-WindowState 'invalid expected PID nullable unknown' @{ pid = 0 } $null $null
    Test-WindowState 'foreign owner nullable unknown' @{ owners = @(7) } $null $null
    Test-WindowState 'disappears after first observations' @{ valid = @($true, $false) } $null $null
    Test-WindowState 'owner changes around observations' @{ owners = @(123, 7) } $null $null
    Test-WindowState 'failed native rect nullable unknown no UIA fallback' @{ rectSuccess = @($false) } $null $null
    Test-WindowState 'zero-size native rect nullable unknown' @{ rectangles = @(,@(10, 20, 10, 70)) } $null $null
    Test-WindowState 'inverted native rect nullable unknown' @{ rectangles = @(,@(60, 20, 10, 70)) } $null $null
    Test-WindowState 'iconic state contradiction nullable unknown' @{ iconic = @($false, $true) } $null $null
    Test-WindowState 'minimized state contradiction nullable unknown' @{ iconic = @($true, $false) } $null $null
    Test-WindowState 'rect changes between observations nullable unknown' @{ rectangles = @(@(10, 20, 60, 70), @(11, 20, 61, 70)) } $null $null
    Test-WindowState 'monitor changes between observations nullable unknown' @{ monitors = @(5, 0) } $null $null
    Test-WindowState 'disappears after corroboration nullable unknown' @{ valid = @($true, $true, $false) } $null $null
    foreach ($method in @('IsWindow:', 'GetWindowProcessId:', 'IsIconic:', 'GetWindowRect:', 'MonitorFromWindow:')) {
        Test-WindowState "native invocation $method failure nullable unknown" @{ throwOn = $method } $null $null
    }
    if (-not $definitions.ContainsKey('Get-OrcaWindowVisibilityState')) { throw 'Narrow visibility helper not present' }
    $helperText = $definitions['Get-OrcaWindowVisibilityState']
    $helperTokens = $null; $helperErrors = $null
    $null = [System.Management.Automation.Language.Parser]::ParseInput($helperText, [ref]$helperTokens, [ref]$helperErrors)
    $helperCode = ($helperTokens | Where-Object { $_.Kind -ne 'Comment' } | ForEach-Object { $_.Text }) -join ''
    if ($helperCode -match 'Screen\.AllScreens|Get-OrcaWindowFrame|Automation|RootElement|DPI|SetForegroundWindow|ShowWindow|Restore-OrcaWindow|SendInput') { throw 'Visibility classifier introduced DPI/UIA/focus/restore/input fallback' }
    $runtimeSource = [IO.File]::ReadAllText($runtimePath)
    if ($runtimeSource -notmatch '(?s)\[DllImport\("user32\.dll"\)\]\s+public static extern IntPtr MonitorFromWindow\(IntPtr hwnd, uint flags\);') { throw 'Exact MonitorFromWindow P/Invoke signature missing' }
    $script:passed += 'static native signature and forbidden fallback/action guard'
    [ordered]@{ status = 'passed'; cases = $script:passed; count = $script:passed.Count; powershell = $PSVersionTable.PSVersion.ToString(); nativeProductionLoaded = $false; realNativeCalls = $false } | ConvertTo-Json -Depth 5 -Compress
} catch {
    [ordered]@{ status = 'failed'; cases = $script:passed; count = $script:passed.Count; error = $_.Exception.Message; powershell = $PSVersionTable.PSVersion.ToString(); nativeProductionLoaded = $false; realNativeCalls = $false } | ConvertTo-Json -Depth 5 -Compress
    throw
}
