param([string]$RuntimePath = (Join-Path $PSScriptRoot "runtime.ps1"))

$ErrorActionPreference = "Stop"

function Assert-TestEqual($Actual, $Expected, [string]$Label) {
    if ($Actual -cne $Expected) { throw "$Label expected '$Expected', received '$Actual'" }
}

Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;

public static class OrcaDesktopWin32 {
    public static readonly List<string> Calls = new List<string>();
    public static IntPtr Foreground;
    public static string EditText;
    public static int[] Selection;
    public static int EditOwner;
    public static bool IgnoreInsertion;

    public static void Reset(string text, int start, int end) {
        Calls.Clear();
        Foreground = new IntPtr(202);
        EditText = text;
        Selection = new[] { start, end };
        EditOwner = 4242;
        IgnoreInsertion = false;
    }
    public static int GetProcessIntegrityLevel(int processId) { return 0x2000; }
    public static IntPtr GetForegroundWindow() { return Foreground; }
    public static bool SetForegroundWindow(IntPtr hwnd) { Calls.Add("activate"); return false; }
    public static bool IsIconic(IntPtr hwnd) { return false; }
    public static bool ShowWindow(IntPtr hwnd, int command) { Calls.Add("restore"); return true; }
    public static bool IsWindow(IntPtr hwnd) { return true; }
    public static int GetWindowLong(IntPtr hwnd, int index) { return 0x0004; }
    public static uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId) {
        processId = hwnd == new IntPtr(303) ? (uint)EditOwner : (hwnd == new IntPtr(101) ? 4242u : 1u);
        return 1;
    }
    public static string GetEditText(IntPtr hwnd, int maxLength) { return EditText; }
    public static int[] GetEditSelection(IntPtr hwnd) { return Selection; }
    public static bool ReplaceEditSelection(IntPtr hwnd, string text) {
        Calls.Add("replace:" + text);
        if (!IgnoreInsertion) {
            EditText = EditText.Substring(0, Selection[0]) + text + EditText.Substring(Selection[1]);
        }
        return true;
    }
    public static bool SendUnicodeText(string text) { Calls.Add("keys:" + text); return true; }
}
"@

$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($RuntimePath, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
$functions = @(
    "Test-OrcaWindowFocused", "Wait-OrcaWindowFocused", "Assert-OrcaKeyboardFocus", "New-OrcaForegroundRefusal",
    "Assert-OrcaWindowTarget", "Get-OrcaRequiredString", "Invoke-OrcaOperation",
    "Assert-OrcaInputAllowed", "Test-OrcaTargetTookForeground", "Get-OrcaProperty", "Test-OrcaSensitiveElement",
    "Test-OrcaEditClass", "Get-OrcaNativeEdit", "Assert-OrcaEditOwner", "ConvertTo-OrcaEditNewlines",
    "Invoke-OrcaEditTextInsertion", "Invoke-OrcaElementTextInsertion", "Send-OrcaText",
    "Test-OrcaElementDisabled", "Assert-OrcaStillFocused"
)
foreach ($definition in $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $false)) {
    if ($definition.Name -in $functions) { . ([scriptblock]::Create($definition.Extent.Text)) }
}

$EditReadbackLimit = 1048576
function Find-OrcaProcess { [pscustomobject]@{ MainWindowHandle = 101; Id = 4242; ProcessName = "Fixture" } }
function Get-OrcaAppName($Process) { $Process.ProcessName }
function Get-OrcaRootElement { $null }
function Get-OrcaWindowFrame { @{ x = 100; y = 200 } }
function Find-OrcaElement($RootElement, $Record) { if ($null -eq $Record) { $null } else { $Record.live } }
function Invoke-OrcaValueTextInsertion { $script:valueWrites++; $null }
function Send-OrcaKey { [OrcaDesktopWin32]::Calls.Add("sendkeys") }
function Send-OrcaHotkey { [OrcaDesktopWin32]::Calls.Add("sendkeys") }
function Send-OrcaPasteText { [OrcaDesktopWin32]::Calls.Add("sendkeys") }
function New-OrcaSnapshot { [pscustomobject]@{} }
function Restore-OrcaWindow { [OrcaDesktopWin32]::Calls.Add("activate"); $null }

function New-TestElement([string]$ClassName, [int64]$Handle, [bool]$Enabled = $true, [string]$ControlType = "ControlType.Document") {
    $live = [pscustomobject]@{
        Current = [pscustomobject]@{
            ClassName = $ClassName; NativeWindowHandle = $Handle; IsPassword = $false; IsEnabled = $Enabled; Name = "Body"
            AutomationId = ""; LocalizedControlType = "document"; ControlType = [pscustomobject]@{ ProgrammaticName = $ControlType }
        }
    }
    [pscustomobject]@{ index = 7; live = $live }
}

function Invoke-TestOperation($Operation) {
    $message = $null
    $result = $null
    try { $result = Invoke-OrcaOperation $Operation } catch { $message = $_.Exception.Message }
    [pscustomobject]@{ result = $result; message = $message }
}

# Background keyboard verbs refuse before any key leaves, and say how to enter text without the foreground.
foreach ($operation in @(
    [pscustomobject]@{ tool = "type_text"; text = "hello" },
    [pscustomobject]@{ tool = "paste_text"; text = "hello" },
    [pscustomobject]@{ tool = "press_key"; key = "Return" },
    [pscustomobject]@{ tool = "hotkey"; key = "Ctrl+A" }
)) {
    [OrcaDesktopWin32]::Reset("", 0, 0)
    $operation | Add-Member -NotePropertyName app -NotePropertyValue "Fixture"
    $outcome = Invoke-TestOperation $operation
    if ($outcome.message -notlike "background_unavailable: *takes the user's keyboard; nothing was sent.*type-text --element-index*Ask the user before retrying with --restore-window.") {
        throw "$($operation.tool) background refusal, received '$($outcome.message)'"
    }
    Assert-TestEqual ([OrcaDesktopWin32]::Calls.Count) 0 "$($operation.tool) background refusal sends nothing"
}

# Typing into a native edit replaces its selection in the background and reads the result back.
[OrcaDesktopWin32]::Reset("one`r`nthree", 3, 3)
$outcome = Invoke-TestOperation ([pscustomobject]@{ tool = "type_text"; app = "Fixture"; text = "`ntwo"; element = (New-TestElement "Edit" 303) })
if ($null -ne $outcome.message) { throw "edit insertion failed: $($outcome.message)" }
Assert-TestEqual ([OrcaDesktopWin32]::Calls -join "|") "replace:`r`ntwo" "edit insertion sends one EM_REPLACESEL with CRLF line breaks"
Assert-TestEqual ([OrcaDesktopWin32]::EditText) "one`r`ntwo`r`nthree" "edit insertion result"
Assert-TestEqual $outcome.result.action.actionName "EM_REPLACESEL" "edit insertion action"
Assert-TestEqual $outcome.result.action.delivery "background" "edit insertion delivery"
Assert-TestEqual $outcome.result.action.verification.state "verified" "edit insertion verification"

# A field that ignores the insertion is an error, not a typed result.
[OrcaDesktopWin32]::Reset("same", 4, 4)
[OrcaDesktopWin32]::IgnoreInsertion = $true
$outcome = Invoke-TestOperation ([pscustomobject]@{ tool = "type_text"; app = "Fixture"; text = "x"; element = (New-TestElement "Edit" 303) })
if ($outcome.message -notlike "text_insertion_unconfirmed:*") { throw "ignored insertion, received '$($outcome.message)'" }

# Replacing a selection with the same text changes nothing yet is the requested result.
[OrcaDesktopWin32]::Reset("abc", 0, 3)
$outcome = Invoke-TestOperation ([pscustomobject]@{ tool = "type_text"; app = "Fixture"; text = "abc"; element = (New-TestElement "Edit" 303) })
if ($null -ne $outcome.message) { throw "identical replacement failed: $($outcome.message)" }
Assert-TestEqual $outcome.result.action.verification.state "verified" "identical replacement verification"

# Edit messages would bypass a disabled field's lock, so a disabled field is refused untouched.
[OrcaDesktopWin32]::Reset("", 0, 0)
$outcome = Invoke-TestOperation ([pscustomobject]@{ tool = "type_text"; app = "Fixture"; text = "x"; element = (New-TestElement "Edit" 303 $false) })
if ($outcome.message -notlike "element 7 text is not settable: the field is disabled") { throw "disabled edit, received '$($outcome.message)'" }
Assert-TestEqual ([OrcaDesktopWin32]::Calls.Count) 0 "disabled edit sends nothing"

# A recycled window handle owned by another process is never messaged.
[OrcaDesktopWin32]::Reset("", 0, 0)
[OrcaDesktopWin32]::EditOwner = 999
$outcome = Invoke-TestOperation ([pscustomobject]@{ tool = "type_text"; app = "Fixture"; text = "x"; element = (New-TestElement "Edit" 303) })
if ($outcome.message -notlike "stale element:*") { throw "recycled edit handle, received '$($outcome.message)'" }
Assert-TestEqual ([OrcaDesktopWin32]::Calls.Count) 0 "recycled edit handle sends nothing"

# An element with no background text route refuses instead of typing at whatever has focus.
[OrcaDesktopWin32]::Reset("", 0, 0)
$outcome = Invoke-TestOperation ([pscustomobject]@{ tool = "type_text"; app = "Fixture"; text = "x"; element = (New-TestElement "Chrome_RenderWidgetHostHWND" 404) })
if ($outcome.message -notlike "background_unavailable: element 7 accepts text only as keys*") { throw "no text route, received '$($outcome.message)'" }
Assert-TestEqual ([OrcaDesktopWin32]::Calls.Count) 0 "no text route sends nothing"

# List and tree items take ValuePattern too, where a write would rename them, so they are refused untouched.
[OrcaDesktopWin32]::Reset("", 0, 0)
$script:valueWrites = 0
$outcome = Invoke-TestOperation ([pscustomobject]@{ tool = "type_text"; app = "Fixture"; text = "x"; element = (New-TestElement "" 0 $true "ControlType.ListItem") })
if ($outcome.message -notlike "element 7 text is not settable: it is not a text field") { throw "list item, received '$($outcome.message)'" }
Assert-TestEqual ([OrcaDesktopWin32]::Calls.Count + $script:valueWrites) 0 "list item sends nothing"

# Foreground typing re-checks focus right before SendInput, so a user's switch never receives the text.
[OrcaDesktopWin32]::Reset("", 0, 0)
[OrcaDesktopWin32]::Foreground = [IntPtr]101
$outcome = Invoke-TestOperation ([pscustomobject]@{ tool = "type_text"; app = "Fixture"; text = "caf$([char]0x00E9)"; restoreWindow = $true })
if ($null -ne $outcome.message) { throw "foreground typing failed: $($outcome.message)" }
Assert-TestEqual (@([OrcaDesktopWin32]::Calls | Where-Object { $_ -like "keys:*" }) -join "|") "keys:caf$([char]0x00E9)" "foreground typing sends Unicode input"
Write-Output "windows-text-entry-tests-ok"
