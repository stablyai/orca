$ErrorActionPreference = 'Stop'

function Assert-TestEqual($Actual, $Expected, [string]$Label) {
    if ($Actual -ne $Expected) { throw "$Label expected '$Expected', received '$Actual'" }
}

function Assert-TestThrows([scriptblock]$Action, [string]$Expected, [string]$Label) {
    try { & $Action } catch {
        if ($_.Exception.Message -like "*$Expected*") { return }
        throw "$Label expected '$Expected', received '$($_.Exception.Message)'"
    }
    throw "$Label expected an error"
}

$runtimePath = Join-Path $PSScriptRoot 'runtime.ps1'
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($runtimePath, [ref]$tokens, [ref]$errors)
if ($errors.Count -ne 0) { throw 'runtime.ps1 failed PowerShell parse' }

$functionNames = @(
    'Test-OrcaTransientWindowClass',
    'Test-OrcaUsableWindowHandle',
    'Get-OrcaWindowCandidates',
    'Resolve-OrcaWindowHandle',
    'Get-OrcaWindowId',
    'Assert-OrcaWindowTarget',
    'Restore-OrcaWindow'
)
foreach ($name in $functionNames) {
    $definition = @($ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true))
    if ($definition.Count -ne 1) { throw "Expected one function $name" }
    . ([scriptblock]::Create($definition[0].Extent.Text))
}

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
public static class OrcaDesktopWin32 {
    public static readonly Dictionary<long, int> ProcessIds = new Dictionary<long, int>();
    public static readonly Dictionary<long, string> Classes = new Dictionary<long, string>();
    public static readonly Dictionary<long, bool> Iconic = new Dictionary<long, bool>();
    public static readonly HashSet<long> Visible = new HashSet<long>();
    public static readonly List<string> Calls = new List<string>();
    public static IntPtr Foreground;
    public static IntPtr[] Handles = new IntPtr[0];
    public static bool IsWindow(IntPtr hwnd) { return ProcessIds.ContainsKey(hwnd.ToInt64()); }
    public static bool IsWindowVisible(IntPtr hwnd) { return Visible.Contains(hwnd.ToInt64()); }
    public static int GetWindowProcessId(IntPtr hwnd) { return ProcessIds[hwnd.ToInt64()]; }
    public static string GetWindowClassName(IntPtr hwnd) { return Classes[hwnd.ToInt64()]; }
    public static IntPtr[] GetTopLevelWindowsForProcess(int processId) { return Handles; }
    public static IntPtr GetForegroundWindow() { return Foreground; }
    public static bool IsIconic(IntPtr hwnd) { return Iconic[hwnd.ToInt64()]; }
    public static bool ShowWindow(IntPtr hwnd, int command) { Calls.Add("ShowWindow:" + hwnd.ToInt64() + ":" + command); return true; }
    public static bool SetForegroundWindow(IntPtr hwnd) { Calls.Add("SetForegroundWindow:" + hwnd.ToInt64()); return true; }
    public static void Reset() { ProcessIds.Clear(); Classes.Clear(); Iconic.Clear(); Visible.Clear(); Calls.Clear(); Foreground = IntPtr.Zero; Handles = new IntPtr[0]; }
    public static void Add(long handle, int processId, string className, bool visible, bool iconic) {
        ProcessIds.Add(handle, processId); Classes.Add(handle, className); Iconic.Add(handle, iconic); if (visible) { Visible.Add(handle); }
    }
}
'@

function Set-TestWindows([object[]]$Windows, [long]$Foreground = 0) {
    [OrcaDesktopWin32]::Reset()
    $handles = @()
    foreach ($window in $Windows) {
        [OrcaDesktopWin32]::Add([long]$window.handle, [int]$window.pid, [string]$window.className, [bool]$window.visible, [bool]$window.iconic)
        $handles += [IntPtr][long]$window.handle
    }
    [OrcaDesktopWin32]::Handles = [IntPtr[]]$handles
    [OrcaDesktopWin32]::Foreground = [IntPtr]$Foreground
}

$process = [pscustomobject]@{ Id = 12580; ProcessName = 'FixtureOrca'; MainWindowHandle = [IntPtr]4524846 }

# A tooltip may win MainWindowHandle, but a foreground application window for the same PID wins.
Set-TestWindows @(
    @{ handle = 2754034; pid = 12580; className = 'Chrome_WidgetWin_1'; visible = $true; iconic = $false },
    @{ handle = 4524846; pid = 12580; className = 'tooltips_class32'; visible = $true; iconic = $false }
) 2754034
$handle = Resolve-OrcaWindowHandle $process
Assert-TestEqual $handle.ToInt64() 2754034 'foreground app handle excludes tooltip'
Assert-OrcaWindowTarget $handle 2754034 $null
Assert-TestThrows { Assert-OrcaWindowTarget $handle 4524846 $null } 'windowNotFound' 'tooltip target rejected'

# A normal visible modal remains eligible; only transient menu/tooltip classes are excluded.
Set-TestWindows @(
    @{ handle = 2754034; pid = 12580; className = 'Chrome_WidgetWin_1'; visible = $true; iconic = $false },
    @{ handle = 2754035; pid = 12580; className = '#32770'; visible = $true; iconic = $false }
) 2754035
Assert-TestEqual (Resolve-OrcaWindowHandle $process).ToInt64() 2754035 'foreground modal remains eligible'

# A stale or foreign MainWindowHandle cannot select a foreign window; one valid candidate is safe.
$process.MainWindowHandle = [IntPtr]9999999
Set-TestWindows @(
    @{ handle = 2754034; pid = 12580; className = 'Chrome_WidgetWin_1'; visible = $true; iconic = $false },
    @{ handle = 90210; pid = 7; className = 'Chrome_WidgetWin_1'; visible = $true; iconic = $false }
)
Assert-TestEqual (Resolve-OrcaWindowHandle $process).ToInt64() 2754034 'foreign handle rejected'

# Without a valid foreground/main handle, multiple legitimate candidates are ambiguous and fail closed.
Set-TestWindows @(
    @{ handle = 2754034; pid = 12580; className = 'Chrome_WidgetWin_1'; visible = $true; iconic = $false },
    @{ handle = 2754035; pid = 12580; className = '#32770'; visible = $true; iconic = $false }
)
Assert-TestThrows { Resolve-OrcaWindowHandle $process } 'No unambiguous' 'ambiguous windows fail closed'

# Focusing a maximized window never sends SW_RESTORE; a minimized window receives it before focus.
Set-TestWindows @(@{ handle = 2754034; pid = 12580; className = 'Chrome_WidgetWin_1'; visible = $true; iconic = $false })
Restore-OrcaWindow ([IntPtr]2754034)
Assert-TestEqual (([OrcaDesktopWin32]::Calls -join '|')) 'SetForegroundWindow:2754034' 'maximized window is not restored'
Set-TestWindows @(@{ handle = 2754034; pid = 12580; className = 'Chrome_WidgetWin_1'; visible = $true; iconic = $true })
Restore-OrcaWindow ([IntPtr]2754034)
Assert-TestEqual (([OrcaDesktopWin32]::Calls -join '|')) 'ShowWindow:2754034:9|SetForegroundWindow:2754034' 'minimized window restores then focuses'

Write-Output 'windows-window-targeting-tests-ok'
