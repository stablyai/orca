param([string]$RuntimePath = (Join-Path $PSScriptRoot "runtime.ps1"))

$ErrorActionPreference = "Stop"

function Assert-TestEqual($Actual, $Expected, [string]$Label) {
    if ($Actual -ne $Expected) { throw "$Label expected '$Expected', received '$Actual'" }
}

Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;

public static class OrcaDesktopWin32 {
    public static readonly List<string> Calls = new List<string>();
    public static bool AllowActivation;
    public static IntPtr Foreground;
    public static IntPtr Pending;
    public static int FocusReads;
    public static int WindowX;
    public static int TargetIntegrity;

    public static void Reset(bool allow) {
        TargetIntegrity = 0x2000;
        Calls.Clear();
        AllowActivation = allow;
        Foreground = new IntPtr(202);
        Pending = IntPtr.Zero;
        FocusReads = 0;
        WindowX = 100;
    }
    public static int GetProcessIntegrityLevel(int processId) {
        return processId == 4242 ? TargetIntegrity : 0x2000;
    }
    public static bool IsIconic(IntPtr hwnd) {
        return false;
    }
    public static bool ShowWindow(IntPtr hwnd, int command) {
        Calls.Add("restore");
        return true;
    }
    public static bool SetForegroundWindow(IntPtr hwnd) {
        Calls.Add("activate");
        Pending = hwnd;
        return AllowActivation;
    }
    public static IntPtr GetForegroundWindow() {
        FocusReads++;
        if (AllowActivation && FocusReads >= 2) {
            Foreground = Pending;
            WindowX = 500;
        }
        return Foreground;
    }
    public static uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId) {
        processId = hwnd == new IntPtr(101) ? 4242u : 1u;
        return 1;
    }
    public static bool SetCursorPos(int x, int y) {
        Calls.Add("move:" + x + "," + y);
        return true;
    }
    public static void mouse_event(uint flags, uint dx, uint dy, int data, UIntPtr extra) {
        Calls.Add("mouse");
    }
    public static void SendModifiedClick(byte[] modifiers, uint down, uint up) {
        Calls.Add("modified");
    }
}
"@

$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($RuntimePath, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
$functions = @(
    "Test-OrcaWindowFocused", "Wait-OrcaWindowFocused", "Assert-OrcaKeyboardFocus",
    "Assert-OrcaPointerFocus", "Restore-OrcaWindow", "Restore-OrcaPointerWindow", "Assert-OrcaWindowTarget",
    "Get-OrcaRequiredNumber", "Get-OrcaPositiveInteger", "Get-OrcaPositiveNumber",
    "Get-OrcaScreenPoint", "Get-OrcaElementScreenPoint", "Get-OrcaModifierVirtualKey",
    "Get-OrcaClickModifierVirtualKeys", "Send-OrcaMouseClick", "Send-OrcaDrag", "Invoke-OrcaOperation",
    "Assert-OrcaInputAllowed", "Test-OrcaTargetTookForeground"
)
foreach ($definition in $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $false)) {
    if ($definition.Name -in $functions) { . ([scriptblock]::Create($definition.Extent.Text)) }
}

$MouseEvents = @{ LeftDown = 2; LeftUp = 4; RightDown = 8; RightUp = 16; MiddleDown = 32; MiddleUp = 64; Wheel = 2048; HorizontalWheel = 4096 }
function Find-OrcaProcess { [pscustomobject]@{ MainWindowHandle = 101; Id = 4242; ProcessName = "Fixture" } }
function Get-OrcaAppName($Process) { $Process.ProcessName }
function Get-OrcaRootElement { $null }
function Get-OrcaWindowFrame { @{ x = [OrcaDesktopWin32]::WindowX; y = 200 } }
function Find-OrcaElement($RootElement, $Record) { $Record }
function Invoke-OrcaPrimaryAction($Element) { $null -ne $Element }
function Invoke-OrcaScrollPattern($Element, $RootElement, $Direction, $Pages) { $null -ne $Element }
function New-OrcaSnapshot { [pscustomobject]@{} }

foreach ($case in @(
    @{ tool = "click"; x = 5; y = 6 },
    @{ tool = "scroll"; x = 5; y = 6; direction = "down"; pages = 1 },
    @{ tool = "drag"; from_x = 5; from_y = 6; to_x = 25; to_y = 26 }
)) {
    foreach ($activates in @($false, $true)) {
        [OrcaDesktopWin32]::Reset($activates)
        $operation = [pscustomobject]@{ app = "Fixture"; noScreenshot = $true; restoreWindow = $false }
        foreach ($key in $case.Keys) { $operation | Add-Member -NotePropertyName $key -NotePropertyValue $case[$key] }
        $denied = $false
        try {
            $result = Invoke-OrcaOperation $operation
        } catch {
            if ($_.Exception.Message -notlike "window_not_focused:*") { throw }
            $denied = $true
        }
        $inputCalls = @([OrcaDesktopWin32]::Calls | Where-Object { $_ -like "move:*" -or $_ -in @("mouse", "modified") })
        if ($activates) {
            Assert-TestEqual $denied $false "$($case.tool) successful activation"
            Assert-TestEqual $result.ok $true "$($case.tool) result"
            if ($inputCalls.Count -eq 0) { throw "$($case.tool) did not send pointer input after activation" }
            if ([OrcaDesktopWin32]::FocusReads -lt 2) { throw "$($case.tool) did not wait for activation" }
            Assert-TestEqual $inputCalls[0] "move:505,206" "$($case.tool) geometry after delayed activation"
            Assert-TestEqual $result.action.delivery "foreground" "$($case.tool) pointer delivery"
        } else {
            Assert-TestEqual $denied $true "$($case.tool) denied activation"
            Assert-TestEqual $inputCalls.Count 0 "$($case.tool) denied activation sends no pointer or modifier input"
        }
    }
}

foreach ($case in @(
    @{ tool = "click" },
    @{ tool = "scroll"; direction = "down"; pages = 1 }
)) {
    [OrcaDesktopWin32]::Reset($false)
    $operation = [pscustomobject]@{ app = "Fixture"; element = [pscustomobject]@{ index = 1 } }
    foreach ($key in $case.Keys) { $operation | Add-Member -NotePropertyName $key -NotePropertyValue $case[$key] }
    $result = Invoke-OrcaOperation $operation
    Assert-TestEqual $result.action.path "accessibility" "pattern $($case.tool) path"
    Assert-TestEqual $result.action.delivery "background" "pattern $($case.tool) delivery"
    Assert-TestEqual ([OrcaDesktopWin32]::Calls.Count) 0 "pattern $($case.tool) bypasses activation and global input"
}
foreach ($case in @(
    @{ tool = "click"; element = [pscustomobject]@{ index = 1 } },
    @{ tool = "click"; x = 5; y = 6; restoreWindow = $true },
    @{ tool = "type_text"; text = "x"; restoreWindow = $true }
)) {
    [OrcaDesktopWin32]::Reset($true)
    [OrcaDesktopWin32]::TargetIntegrity = 0x3000
    $operation = [pscustomobject]@{ app = "Fixture"; noScreenshot = $true }
    foreach ($key in $case.Keys) { $operation | Add-Member -NotePropertyName $key -NotePropertyValue $case[$key] }
    $message = $null
    try { Invoke-OrcaOperation $operation | Out-Null } catch { $message = $_.Exception.Message }
    if ($message -notlike "target_elevated:*") { throw "$($case.tool) elevated target expected target_elevated, received '$message'" }
    Assert-TestEqual ([OrcaDesktopWin32]::Calls.Count) 0 "$($case.tool) elevated target sends no activation or input"
}
# Why: WPF activates its own window for most patterns; the result must say so rather than claim background.
[OrcaDesktopWin32]::Reset($false)
function Invoke-OrcaPrimaryAction($Element) { [OrcaDesktopWin32]::Foreground = [IntPtr]101; $true }
$result = Invoke-OrcaOperation ([pscustomobject]@{ tool = "click"; app = "Fixture"; element = [pscustomobject]@{ index = 1 } })
Assert-TestEqual $result.action.path "accessibility" "self-activating pattern click path"
Assert-TestEqual $result.action.delivery "foreground" "self-activating pattern click delivery"
Write-Output "windows-pointer-tests-ok"
