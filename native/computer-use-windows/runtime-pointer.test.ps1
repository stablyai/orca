param([string]$RuntimePath = (Join-Path $PSScriptRoot "runtime.ps1"))

$ErrorActionPreference = "Stop"

function Assert-TestEqual($Actual, $Expected, [string]$Label) {
    if ($Actual -ne $Expected) { throw "$Label expected '$Expected', received '$Actual'" }
}

function Assert-TestLike([string]$Actual, [string]$Pattern, [string]$Label) {
    if ($Actual -notlike $Pattern) { throw "$Label expected '$Pattern', received '$Actual'" }
}

Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;

public static class OrcaDesktopWin32 {
    public struct POINT { public int X; public int Y; }

    public static readonly List<string> Calls = new List<string>();
    // Which SetForegroundWindow call (1-based) Windows honours; 0 refuses them all.
    public static int HonouredRaise;
    public static bool HonourUiaActivation;
    public static bool Cloaked;
    public static IntPtr Foreground;
    public static IntPtr Pending;
    public static int ReadsSinceActivation;
    public static int Raises;
    public static int WindowX;
    public static int TargetIntegrity;

    public static void Reset(int honouredRaise) {
        TargetIntegrity = 0x2000;
        Calls.Clear();
        HonouredRaise = honouredRaise;
        HonourUiaActivation = false;
        Cloaked = false;
        Foreground = new IntPtr(202);
        Pending = IntPtr.Zero;
        ReadsSinceActivation = 0;
        Raises = 0;
        WindowX = 100;
    }
    public static void Activate(IntPtr hwnd) {
        Pending = hwnd;
        ReadsSinceActivation = 0;
    }
    public static int GetProcessIntegrityLevel(int processId) {
        return processId == 4242 ? TargetIntegrity : 0x2000;
    }
    public static bool IsIconic(IntPtr hwnd) {
        return false;
    }
    public static bool IsWindowCloaked(IntPtr hwnd) {
        return Cloaked;
    }
    public static bool ShowWindow(IntPtr hwnd, int command) {
        Calls.Add("restore");
        return true;
    }
    public static bool SetForegroundWindow(IntPtr hwnd) {
        Calls.Add("activate");
        Raises++;
        if (Raises != HonouredRaise) { return false; }
        Activate(hwnd);
        return true;
    }
    // Activation lands a moment later, and restoring the window moves its frame.
    public static IntPtr GetForegroundWindow() {
        if (Pending != IntPtr.Zero && ++ReadsSinceActivation >= 2) {
            Foreground = Pending;
            Pending = IntPtr.Zero;
            WindowX = 500;
        }
        return Foreground;
    }
    public static uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId) {
        processId = hwnd == new IntPtr(101) ? 4242u : 1u;
        return 1;
    }
    public static bool GetCursorPos(out POINT point) {
        point = new POINT { X = 7, Y = 8 };
        return true;
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
    "Test-OrcaWindowFocused", "Wait-OrcaWindowFocused", "Assert-OrcaKeyboardFocus", "Restore-OrcaWindow",
    "Restore-OrcaPointerWindow", "New-OrcaForegroundRefusal", "Get-OrcaCursorPosition", "Restore-OrcaCursorPosition",
    "Assert-OrcaWindowTarget", "Get-OrcaRequiredNumber", "Get-OrcaPositiveInteger", "Get-OrcaPositiveNumber",
    "Assert-OrcaElementFound", "Get-OrcaPointerPoint", "Get-OrcaElementScreenPoint", "Get-OrcaModifierVirtualKey",
    "Get-OrcaClickModifierVirtualKeys", "Send-OrcaMouseClick", "Send-OrcaDrag", "Invoke-OrcaOperation",
    "Assert-OrcaInputAllowed", "Test-OrcaTargetTookForeground", "Invoke-OrcaPrimaryAction", "Get-OrcaScrollPattern",
    "Get-OrcaScrollPercent", "Get-OrcaScrollViewSize", "Wait-OrcaScrollPercentChange", "Invoke-OrcaScrollPercent",
    "Invoke-OrcaScrollPattern"
)
foreach ($definition in $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $false)) {
    if ($definition.Name -in $functions) { . ([scriptblock]::Create($definition.Extent.Text)) }
}

$MouseEvents = @{ LeftDown = 2; LeftUp = 4; RightDown = 8; RightUp = 16; MiddleDown = 32; MiddleUp = 64; Wheel = 2048; HorizontalWheel = 4096 }
function Find-OrcaProcess { [pscustomobject]@{ MainWindowHandle = 101; Id = 4242; ProcessName = "Fixture" } }
function Get-OrcaAppName($Process) { $Process.ProcessName }
function Get-OrcaRootElement { $null }
function Get-OrcaWindowFrame { @{ x = [OrcaDesktopWin32]::WindowX; y = 200 } }
function Find-OrcaElement($RootElement, $Record) { if ($null -ne $Record -and -not $Record.stale) { $Record } else { $null } }
function Get-OrcaElementScreenPoint($Element) { if ($null -ne $Element) { @{ x = [OrcaDesktopWin32]::WindowX + 40; y = 240 } } else { $null } }
function Test-OrcaElementDisabled($Element) { [bool]$Element.disabled }
function Invoke-OrcaWindowPatternActivation($RootElement) {
    [OrcaDesktopWin32]::Calls.Add("uia-activate")
    if ([OrcaDesktopWin32]::HonourUiaActivation) { [OrcaDesktopWin32]::Activate([IntPtr]101) }
}
function Find-OrcaScrollContainerAt { $null }
function New-OrcaSnapshot { [pscustomobject]@{} }

function Invoke-TestOperation([hashtable]$Fields) {
    $operation = [pscustomobject]@{ app = "Fixture"; noScreenshot = $true }
    foreach ($key in $Fields.Keys) { $operation | Add-Member -NotePropertyName $key -NotePropertyValue $Fields[$key] }
    try {
        [pscustomobject]@{ result = Invoke-OrcaOperation $operation; message = $null }
    } catch {
        [pscustomobject]@{ result = $null; message = $_.Exception.Message }
    }
}

function Get-TestPointerCalls {
    @([OrcaDesktopWin32]::Calls | Where-Object { $_ -like "move:*" -or $_ -in @("mouse", "modified") })
}

# Elements without a primary pattern; pattern-capable ones are records with pattern = $true.
function Invoke-OrcaPrimaryActionStub($Element) { [bool]$Element.pattern }
Set-Item -Path function:Invoke-OrcaPrimaryActionReal -Value (Get-Item function:Invoke-OrcaPrimaryAction).ScriptBlock
Set-Item -Path function:Invoke-OrcaPrimaryAction -Value { param($Element, $Index) Invoke-OrcaPrimaryActionStub $Element }
function Invoke-OrcaScrollPattern($Element, $RootElement, $Direction, $Pages) { [bool]$Element.pattern }

$pointerCases = @(
    @{ tool = "click"; x = 5; y = 6 },
    @{ tool = "click"; element = [pscustomobject]@{ index = 3 } },
    @{ tool = "click"; element = [pscustomobject]@{ index = 3; pattern = $true }; mouse_button = "right" },
    @{ tool = "click"; element = [pscustomobject]@{ index = 3; pattern = $true }; click_count = 2 },
    @{ tool = "click"; element = [pscustomobject]@{ index = 3; pattern = $true }; modifiers = "shift" },
    @{ tool = "scroll"; x = 5; y = 6; direction = "down"; pages = 1 },
    @{ tool = "scroll"; element = [pscustomobject]@{ index = 3 }; direction = "down"; pages = 0.5 },
    @{ tool = "drag"; from_x = 5; from_y = 6; to_x = 25; to_y = 26 }
)

# Without restoreWindow, anything that needs the real mouse is refused before any raise or input.
foreach ($case in $pointerCases) {
    [OrcaDesktopWin32]::Reset(1)
    $outcome = Invoke-TestOperation $case
    $label = "$($case.tool) $(($case.Keys | Sort-Object) -join ',')"
    Assert-TestLike $outcome.message "background_unavailable: *nothing was sent.*Ask the user before retrying with --restore-window." "$label refusal"
    Assert-TestEqual ([OrcaDesktopWin32]::Calls.Count) 0 "$label refusal sends no raise or input"
}

# With restoreWindow: one raise, geometry read after it, and the user's pointer put back behind the input.
foreach ($case in $pointerCases) {
    [OrcaDesktopWin32]::Reset(1)
    $outcome = Invoke-TestOperation ($case + @{ restoreWindow = $true })
    $label = "$($case.tool) $(($case.Keys | Sort-Object) -join ',') restored"
    if ($null -ne $outcome.message) { throw "$label failed: $($outcome.message)" }
    Assert-TestEqual $outcome.result.action.delivery "foreground" "$label delivery"
    Assert-TestEqual @([OrcaDesktopWin32]::Calls | Where-Object { $_ -eq "activate" }).Count 1 "$label raises once"
    $pointer = Get-TestPointerCalls
    $expectedFirst = if ($null -ne $case.element) { "move:540,240" } else { "move:505,206" }
    Assert-TestEqual $pointer[0] $expectedFirst "$label geometry after delayed activation"
    Assert-TestEqual $pointer[$pointer.Count - 1] "move:7,8" "$label puts the pointer back last"
}

# A refused raise tries the UIA route, then one more raise, and sends nothing when all fail.
[OrcaDesktopWin32]::Reset(0)
$outcome = Invoke-TestOperation @{ tool = "click"; x = 5; y = 6; restoreWindow = $true }
Assert-TestLike $outcome.message "window_not_focused: *no pointer input was sent" "refused raise"
Assert-TestEqual ([OrcaDesktopWin32]::Calls -join " ") "activate uia-activate activate" "refused raise attempts"
[OrcaDesktopWin32]::Reset(2)
$outcome = Invoke-TestOperation @{ tool = "click"; x = 5; y = 6; restoreWindow = $true }
Assert-TestEqual $outcome.result.action.path "synthetic" "second raise honoured"
[OrcaDesktopWin32]::Reset(0)
[OrcaDesktopWin32]::HonourUiaActivation = $true
$outcome = Invoke-TestOperation @{ tool = "click"; x = 5; y = 6; restoreWindow = $true }
Assert-TestEqual $outcome.result.action.path "synthetic" "UIA activation honoured"
Assert-TestEqual @([OrcaDesktopWin32]::Calls | Where-Object { $_ -eq "activate" }).Count 1 "UIA activation skips the second raise"

# A window on another virtual desktop is never raised.
[OrcaDesktopWin32]::Reset(1)
[OrcaDesktopWin32]::Cloaked = $true
$outcome = Invoke-TestOperation @{ tool = "click"; x = 5; y = 6; restoreWindow = $true }
Assert-TestLike $outcome.message "window_not_focused: *another virtual desktop*" "cloaked window"
Assert-TestEqual ([OrcaDesktopWin32]::Calls.Count) 0 "cloaked window sends no raise or input"

# Stale and disabled targets fail before any raise.
foreach ($case in @(
    @{ tool = "click"; element = [pscustomobject]@{ index = 3; stale = $true } },
    @{ tool = "drag"; fromElement = [pscustomobject]@{ index = 3; stale = $true }; to_x = 25; to_y = 26 }
)) {
    [OrcaDesktopWin32]::Reset(1)
    $outcome = Invoke-TestOperation ($case + @{ restoreWindow = $true })
    Assert-TestLike $outcome.message "stale element frame*" "$($case.tool) stale target"
    Assert-TestEqual ([OrcaDesktopWin32]::Calls.Count) 0 "$($case.tool) stale target sends no raise or input"
}
[OrcaDesktopWin32]::Reset(1)
$outcome = Invoke-TestOperation @{ tool = "click"; element = [pscustomobject]@{ index = 3; pattern = $true; disabled = $true }; restoreWindow = $true }
Assert-TestLike $outcome.message "element_not_enabled: element 3 is disabled*" "disabled element"
Assert-TestEqual ([OrcaDesktopWin32]::Calls.Count) 0 "disabled element sends no raise or input"

# UI Automation routes need no raise, even with restoreWindow, and report measured delivery.
foreach ($case in @(
    @{ tool = "click"; element = [pscustomobject]@{ index = 1; pattern = $true } },
    @{ tool = "click"; element = [pscustomobject]@{ index = 1; pattern = $true }; restoreWindow = $true },
    @{ tool = "scroll"; element = [pscustomobject]@{ index = 1; pattern = $true }; direction = "down"; pages = 1 }
)) {
    [OrcaDesktopWin32]::Reset(1)
    $outcome = Invoke-TestOperation $case
    Assert-TestEqual $outcome.result.action.path "accessibility" "pattern $($case.tool) path"
    Assert-TestEqual $outcome.result.action.delivery "background" "pattern $($case.tool) delivery"
    Assert-TestEqual ([OrcaDesktopWin32]::Calls.Count) 0 "pattern $($case.tool) bypasses activation and global input"
}
foreach ($case in @(
    @{ tool = "click"; element = [pscustomobject]@{ index = 1; pattern = $true } },
    @{ tool = "click"; x = 5; y = 6; restoreWindow = $true },
    @{ tool = "type_text"; text = "x"; restoreWindow = $true }
)) {
    [OrcaDesktopWin32]::Reset(1)
    [OrcaDesktopWin32]::TargetIntegrity = 0x3000
    $outcome = Invoke-TestOperation $case
    Assert-TestLike $outcome.message "target_elevated:*" "$($case.tool) elevated target"
    Assert-TestEqual ([OrcaDesktopWin32]::Calls.Count) 0 "$($case.tool) elevated target sends no activation or input"
}
# Why: WPF activates its own window for most patterns; the result must say so rather than claim background.
[OrcaDesktopWin32]::Reset(1)
function Invoke-OrcaPrimaryActionStub($Element) { [OrcaDesktopWin32]::Foreground = [IntPtr]101; $true }
$outcome = Invoke-TestOperation @{ tool = "click"; element = [pscustomobject]@{ index = 1 } }
Assert-TestEqual $outcome.result.action.path "accessibility" "self-activating pattern click path"
Assert-TestEqual $outcome.result.action.delivery "foreground" "self-activating pattern click delivery"

$uiaTypes = $false
try {
    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
    $uiaTypes = $true
} catch {}
if ($uiaTypes) {
    function New-TestPatternElement([scriptblock]$Invoke) {
        $instance = [pscustomobject]@{}
        $instance | Add-Member -MemberType ScriptMethod -Name Invoke -Value $Invoke
        $element = [pscustomobject]@{ instance = $instance }
        $element | Add-Member -MemberType ScriptMethod -Name TryGetCurrentPattern -Value {
            param($pattern, $out)
            if ($pattern -ne [Windows.Automation.InvokePattern]::Pattern) { return $false }
            $out.Value = $this.instance
            $true
        }
        $element
    }
    $disabled = New-TestPatternElement { throw (New-Object Windows.Automation.ElementNotEnabledException) }
    $message = try { Invoke-OrcaPrimaryActionReal $disabled 4 | Out-Null; $null } catch { $_.Exception.Message }
    Assert-TestLike $message "element_not_enabled: element 4 is disabled*" "pattern refusing a disabled element"
    $failing = New-TestPatternElement { throw (New-Object InvalidOperationException "provider gone") }
    $message = try { Invoke-OrcaPrimaryActionReal $failing 4 | Out-Null; $null } catch { $_.Exception.Message }
    Assert-TestLike $message "UI Automation Invoke failed on element 4: *provider gone*no mouse click was sent*" "failing pattern"
    $plain = [pscustomobject]@{}
    $plain | Add-Member -MemberType ScriptMethod -Name TryGetCurrentPattern -Value { param($pattern, $out) $false }
    Assert-TestEqual (Invoke-OrcaPrimaryActionReal $plain 4) $false "element without a primary pattern"

    # Half a page with a quarter of the content visible moves a sixth of the scroll range.
    $scroll = [pscustomobject]@{ Current = [pscustomobject]@{ VerticalViewSize = 25.0; VerticalScrollPercent = 30.0 }; Calls = New-Object System.Collections.Generic.List[string] }
    $scroll | Add-Member -MemberType ScriptMethod -Name SetScrollPercent -Value {
        param($horizontal, $vertical)
        $this.Calls.Add("$horizontal,$([Math]::Round($vertical, 4))")
        $this.Current.VerticalScrollPercent = $vertical
    }
    Assert-TestEqual (Invoke-OrcaScrollPercent $scroll $true $true 0.5 30.0) $true "fractional scroll"
    Assert-TestEqual ($scroll.Calls -join " ") "-1,46.6667" "fractional scroll percent"
    $scroll.Calls.Clear()
    Assert-TestEqual (Invoke-OrcaScrollPercent $scroll $true $false 9.5 46.6667) $true "fractional scroll clamps at the top"
    Assert-TestEqual ($scroll.Calls -join " ") "-1,0" "fractional scroll clamped percent"
    $scroll | Add-Member -Force -MemberType ScriptMethod -Name SetScrollPercent -Value { param($horizontal, $vertical) }
    Assert-TestEqual (Invoke-OrcaScrollPercent $scroll $true $true 0.5 0.0) $false "fractional scroll the provider ignores"
} else {
    Write-Output "skipping UI Automation pattern checks: UIAutomationClient is unavailable"
}
Write-Output "windows-pointer-tests-ok"
