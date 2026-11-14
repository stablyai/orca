param([string]$RuntimePath = (Join-Path $PSScriptRoot "runtime.ps1"))

$ErrorActionPreference = "Stop"

function Assert-TestEqual($Actual, $Expected, [string]$Label) {
    if ($Actual -cne $Expected) { throw "$Label expected '$Expected', received '$Actual'" }
}

Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;

// A combo box and a list box in a fake process 4242, answering the messages the runtime sends.
public static class OrcaDesktopWin32 {
    public static readonly List<string> Calls = new List<string>();
    public static string[] Items;
    public static int Selected;
    public static int Top;
    public static int ListCount;
    public static int ClientHeight;

    public static void Reset(string[] items) {
        Calls.Clear();
        Items = items;
        Selected = 0;
        Top = 0;
        ListCount = 100;
        ClientHeight = 60;
    }
    public static bool IsWindow(IntPtr hwnd) { return true; }
    public static uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId) { processId = 4242; return 1; }
    public static int GetWindowLong(IntPtr hwnd, int index) { return 0; }
    public static IntPtr GetParent(IntPtr hwnd) { return new IntPtr(101); }
    public static int GetDlgCtrlID(IntPtr hwnd) { return 7; }
    public static int GetClientHeight(IntPtr hwnd) { return ClientHeight; }
    // CB_FINDSTRINGEXACT: case-insensitive, searching after start and wrapping.
    public static long? FindControlString(IntPtr hwnd, uint message, int start, string name) {
        for (var step = 1; step <= Items.Length; step++) {
            var index = (start + step + Items.Length) % Items.Length;
            if (string.Equals(Items[index], name, StringComparison.OrdinalIgnoreCase)) { return index; }
        }
        return -1;
    }
    public static string GetControlItemText(IntPtr hwnd, uint lengthMessage, uint textMessage, int index) { return Items[index]; }
    public static long? SendControlMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam) {
        switch (message) {
            case 0x0146: return Items.Length;
            case 0x0147: return Selected;
            case 0x014E: Selected = wParam.ToInt32(); Calls.Add("select:" + Selected); return Selected;
            case 0x0111: Calls.Add("command:" + hwnd + ":" + wParam.ToInt64().ToString("X")); return 0;
            case 0x018E: return Top;
            case 0x018B: return ListCount;
            case 0x01A1: return 15;
            case 0x0197: Top = wParam.ToInt32(); Calls.Add("top:" + Top); return 0;
            default: return 0;
        }
    }
}
"@

$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($RuntimePath, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
$functions = @(
    "Test-OrcaNativeClass", "Test-OrcaEditClass", "Get-OrcaNativeControl", "Assert-OrcaWindowOwner", "Get-OrcaProperty",
    "Set-OrcaNativeComboValue", "Set-OrcaElementValue", "Invoke-OrcaNativeListScroll", "Test-OrcaSameRuntimeId"
)
foreach ($definition in $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $false)) {
    if ($definition.Name -in $functions) { . ([scriptblock]::Create($definition.Extent.Text)) }
}

$process = [pscustomobject]@{ Id = 4242 }
function Get-OrcaRuntimeId($Element) { @($Element.id) }
function Test-OrcaElementDisabled($Element) { -not $Element.Current.IsEnabled }
function Set-OrcaNativeEditValue { $null }
function New-TestControl([string]$ClassName, [bool]$Enabled = $true) {
    [pscustomobject]@{ id = 5; Current = [pscustomobject]@{ ClassName = $ClassName; NativeWindowHandle = 303; IsEnabled = $Enabled } }
}
$combo = New-TestControl "WindowsForms10.COMBOBOX.app.0.1"

# The exact-case option is picked among case-insensitive hits, and the app's change handler is told.
[OrcaDesktopWin32]::Reset(@("Alpha", "gamma", "Gamma"))
$written = Set-OrcaElementValue $combo $process 5 "Gamma"
Assert-TestEqual ([OrcaDesktopWin32]::Calls -join "|") "select:2|command:101:10007" "combo selection messages"
Assert-TestEqual $written.verification.state "verified" "combo verification"

# Two options with the exact name can't be told apart, so nothing is selected.
[OrcaDesktopWin32]::Reset(@("Gamma", "Beta", "Gamma"))
$message = try { Set-OrcaElementValue $combo $process 5 "Gamma" | Out-Null; $null } catch { $_.Exception.Message }
if ($message -notlike "*more than one option is named 'Gamma'*") { throw "ambiguous combo, received '$message'" }
Assert-TestEqual ([OrcaDesktopWin32]::Calls.Count) 0 "ambiguous combo sends nothing"

# A disabled combo box is locked against the user, so it is refused before any message.
[OrcaDesktopWin32]::Reset(@("Alpha", "Gamma"))
$message = try { Set-OrcaElementValue (New-TestControl "ComboBox" $false) $process 5 "Gamma" | Out-Null; $null } catch { $_.Exception.Message }
Assert-TestEqual $message "element_not_enabled: element 5 is disabled, so no input was sent; do what enables it first, then run get-app-state and retry once its line no longer lists disabled" "disabled combo"
Assert-TestEqual ([OrcaDesktopWin32]::Calls.Count) 0 "disabled combo sends nothing"

# A page is the rows the list shows: 60 px at 15 px a row is 4 rows.
$list = New-TestControl "ListBox"
[OrcaDesktopWin32]::Reset(@())
Assert-TestEqual (Invoke-OrcaNativeListScroll $list $list $process "down" 2) $true "list scroll"
Assert-TestEqual ([OrcaDesktopWin32]::Calls -join "|") "top:8" "list scroll top row"

# At the end already, there is nothing to move and nothing falls back to ScrollPattern.
[OrcaDesktopWin32]::Reset(@())
[OrcaDesktopWin32]::Top = 96
Assert-TestEqual (Invoke-OrcaNativeListScroll $list $list $process "down" 1) $true "list at its end"
Assert-TestEqual ([OrcaDesktopWin32]::Calls.Count) 0 "list at its end sends nothing"

# A list that shows all its rows leaves the scroll to an enclosing ScrollPattern.
[OrcaDesktopWin32]::Reset(@())
[OrcaDesktopWin32]::ListCount = 3
Assert-TestEqual (Invoke-OrcaNativeListScroll $list $list $process "down" 1) $false "short list"
Assert-TestEqual ([OrcaDesktopWin32]::Calls.Count) 0 "short list sends nothing"
Write-Output "windows-native-controls-tests-ok"
