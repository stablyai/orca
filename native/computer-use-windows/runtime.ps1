param(
    [Parameter(Position = 0)]
    [string]$OperationPath,
    # Serve mode emits the Add-Type P/Invoke assembly once per session, avoiding per-operation compilation.
    [switch]$Serve
)

$ErrorActionPreference = "Stop"
# Progress records would corrupt the one-JSON-response-per-line serve pipe.
$ProgressPreference = "SilentlyContinue"
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[Console]::InputEncoding = $utf8NoBom
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class OrcaDesktopWin32 {
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT {
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT {
        public uint type;
        public INPUTUNION data;
    }

    [StructLayout(LayoutKind.Explicit)]
    public struct INPUTUNION {
        [FieldOffset(0)]
        public MOUSEINPUT mouse;
        [FieldOffset(0)]
        public KEYBDINPUT keyboard;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint flags;
        public uint time;
        public UIntPtr extraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT {
        public ushort virtualKey;
        public ushort scanCode;
        public uint flags;
        public uint time;
        public UIntPtr extraInfo;
    }

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);

    [DllImport("user32.dll")]
    public static extern bool ScreenToClient(IntPtr hwnd, ref POINT point);

    [DllImport("user32.dll")]
    public static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hwnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hwnd);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int x, int y);

    [DllImport("user32.dll")]
    public static extern void mouse_event(uint dwFlags, uint dx, uint dy, int dwData, UIntPtr dwExtraInfo);

    [DllImport("user32.dll")]
    public static extern uint SendInput(uint count, INPUT[] inputs, int size);

    public static void SendModifiedClick(byte[] modifiers, uint mouseDown, uint mouseUp) {
        const uint keyboardInput = 1;
        const uint mouseInput = 0;
        const uint keyUp = 0x0002;
        var inputs = new List<INPUT>();
        foreach (var modifier in modifiers) {
            inputs.Add(KeyboardInput(keyboardInput, modifier, 0));
        }
        inputs.Add(MouseInput(mouseInput, mouseDown));
        inputs.Add(MouseInput(mouseInput, mouseUp));
        for (var index = modifiers.Length - 1; index >= 0; index--) {
            inputs.Add(KeyboardInput(keyboardInput, modifiers[index], keyUp));
        }
        var values = inputs.ToArray();
        var sent = SendInput((uint)values.Length, values, Marshal.SizeOf(typeof(INPUT)));
        if (sent != (uint)values.Length) {
            var releases = new List<INPUT>();
            releases.Add(MouseInput(mouseInput, mouseUp));
            for (var index = modifiers.Length - 1; index >= 0; index--) {
                releases.Add(KeyboardInput(keyboardInput, modifiers[index], keyUp));
            }
            var releaseValues = releases.ToArray();
            SendInput((uint)releaseValues.Length, releaseValues, Marshal.SizeOf(typeof(INPUT)));
            throw new InvalidOperationException("SendInput did not complete the modified click");
        }
    }

    private static INPUT KeyboardInput(uint type, byte virtualKey, uint flags) {
        return new INPUT {
            type = type,
            data = new INPUTUNION {
                keyboard = new KEYBDINPUT { virtualKey = virtualKey, flags = flags }
            }
        };
    }

    private static INPUT MouseInput(uint type, uint flags) {
        return new INPUT {
            type = type,
            data = new INPUTUNION {
                mouse = new MOUSEINPUT { flags = flags }
            }
        };
    }
}
"@

# Why a second type: the Desktop App pane drives a window in the background, so it needs
# window enumeration and posted messages that never activate the target, unlike the
# foreground SendInput path above.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class OrcaDesktopAppWin32 {
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    public struct GUITHREADINFO {
        public int cbSize; public int flags; public IntPtr hwndActive; public IntPtr hwndFocus;
        public IntPtr hwndCapture; public IntPtr hwndMenuOwner; public IntPtr hwndMoveSize;
        public IntPtr hwndCaret; public RECT rcCaret;
    }

    public sealed class WindowInfo {
        public long Handle; public int ProcessId; public string Title; public string ClassName;
        public int X; public int Y; public int Width; public int Height;
    }

    private delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);

    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr hwnd, uint command);
    [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] private static extern IntPtr GetWindowLongPtr(IntPtr hwnd, int index);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowTextW(IntPtr hwnd, StringBuilder text, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassNameW(IntPtr hwnd, StringBuilder text, int max);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out int processId);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll")] private static extern bool ScreenToClient(IntPtr hwnd, ref POINT point);
    [DllImport("user32.dll")] private static extern IntPtr ChildWindowFromPointEx(IntPtr hwnd, POINT point, uint flags);
    [DllImport("user32.dll")] private static extern bool PostMessageW(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool GetGUIThreadInfo(uint threadId, ref GUITHREADINFO info);
    [DllImport("user32.dll")] private static extern uint MapVirtualKeyW(uint code, uint mapType);
    [DllImport("user32.dll")] private static extern short VkKeyScanW(char character);
    [DllImport("user32.dll")] private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] private static extern IntPtr GetWindowDpiAwarenessContext(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool PhysicalToLogicalPointForPerMonitorDPI(IntPtr hwnd, ref POINT point);
    [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out RECT value, int size);
    [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")] private static extern int DwmGetWindowAttributeInt(IntPtr hwnd, int attribute, out int value, int size);

    private const uint GW_OWNER = 4;
    private const uint GA_ROOT = 2;
    private const int GWL_EXSTYLE = -20;
    private const long WS_EX_TOOLWINDOW = 0x80;
    private const long WS_EX_NOACTIVATE = 0x08000000;
    private const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
    private const int DWMWA_CLOAKED = 14;
    // CWP_SKIPINVISIBLE | CWP_SKIPDISABLED | CWP_SKIPTRANSPARENT
    private const uint CWP_FLAGS = 0x1 | 0x2 | 0x4;

    // Why: per-monitor-v2 awareness makes bounds and points physical pixels, the same space the
    // captured video frame uses; DPI-virtualized coordinates would offset clicks on scaled monitors.
    // Returns the thread's previous context for RestoreDpiContext: the serve loop reuses this
    // thread for every later operation, which expects the awareness it started with.
    public static IntPtr UsePhysicalPixels() {
        try { return SetThreadDpiAwarenessContext(new IntPtr(-4)); } catch (EntryPointNotFoundException) { return IntPtr.Zero; }
    }

    public static void RestoreDpiContext(IntPtr previous) {
        if (previous == IntPtr.Zero) { return; }
        try { SetThreadDpiAwarenessContext(previous); } catch (EntryPointNotFoundException) { }
    }

    public static List<WindowInfo> ListWindows() {
        var windows = new List<WindowInfo>();
        EnumWindows((hwnd, _) => {
            var info = Describe(hwnd);
            if (info != null && IsUserWindow(hwnd)) { windows.Add(info); }
            return true;
        }, IntPtr.Zero);
        return windows;
    }

    public static WindowInfo Describe(IntPtr hwnd) {
        if (!IsWindow(hwnd)) { return null; }
        int processId;
        GetWindowThreadProcessId(hwnd, out processId);
        RECT rect;
        if (DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, out rect, Marshal.SizeOf(typeof(RECT))) != 0) {
            if (!GetWindowRect(hwnd, out rect)) { return null; }
        }
        var title = new StringBuilder(512);
        GetWindowTextW(hwnd, title, title.Capacity);
        var className = new StringBuilder(256);
        GetClassNameW(hwnd, className, className.Capacity);
        return new WindowInfo {
            Handle = hwnd.ToInt64(), ProcessId = processId, Title = title.ToString(), ClassName = className.ToString(),
            X = rect.Left, Y = rect.Top, Width = rect.Right - rect.Left, Height = rect.Bottom - rect.Top
        };
    }

    // Mirrors the macOS list: visible, on-screen, top-level app windows only.
    private static bool IsUserWindow(IntPtr hwnd) {
        if (!IsWindowVisible(hwnd) || IsIconic(hwnd) || GetWindow(hwnd, GW_OWNER) != IntPtr.Zero) { return false; }
        long exStyle = GetWindowLongPtr(hwnd, GWL_EXSTYLE).ToInt64();
        if ((exStyle & WS_EX_TOOLWINDOW) != 0 || (exStyle & WS_EX_NOACTIVATE) != 0) { return false; }
        int cloaked;
        // Why: UWP frames and windows on other virtual desktops stay "visible" but cloaked.
        if (DwmGetWindowAttributeInt(hwnd, DWMWA_CLOAKED, out cloaked, sizeof(int)) == 0 && cloaked != 0) { return false; }
        return true;
    }

    public static bool IsTopLevel(IntPtr hwnd) {
        return IsWindow(hwnd) && GetAncestor(hwnd, GA_ROOT) == hwnd;
    }

    // Deepest enabled, visible child under the screen point, so posted clicks reach the
    // control the user aimed at (buttons, edits) instead of the frame.
    public static IntPtr ChildAt(IntPtr top, int screenX, int screenY) {
        var current = top;
        for (var depth = 0; depth < 32; depth++) {
            var point = new POINT { X = screenX, Y = screenY };
            ScreenToClient(current, ref point);
            var child = ChildWindowFromPointEx(current, point, CWP_FLAGS);
            if (child == IntPtr.Zero || child == current) { break; }
            current = child;
        }
        return current;
    }

    // Why: PostMessage does not rescale lParam, and a DPI-virtualized (unaware or system-aware)
    // target reads it in its own logical pixels; physical points would land up to 2x off.
    public static POINT TargetScreenPoint(IntPtr hwnd, int screenX, int screenY) {
        var point = new POINT { X = screenX, Y = screenY };
        try { PhysicalToLogicalPointForPerMonitorDPI(hwnd, ref point); } catch (EntryPointNotFoundException) { }
        return point;
    }

    public static IntPtr ClientLParam(IntPtr hwnd, int screenX, int screenY) {
        var point = TargetScreenPoint(hwnd, screenX, screenY);
        var previous = IntPtr.Zero;
        try { previous = SetThreadDpiAwarenessContext(GetWindowDpiAwarenessContext(hwnd)); } catch (EntryPointNotFoundException) { }
        try {
            ScreenToClient(hwnd, ref point);
        } finally {
            if (previous != IntPtr.Zero) { SetThreadDpiAwarenessContext(previous); }
        }
        return PackPoint(point.X, point.Y);
    }

    public static IntPtr ScreenLParam(IntPtr hwnd, int screenX, int screenY) {
        var point = TargetScreenPoint(hwnd, screenX, screenY);
        return PackPoint(point.X, point.Y);
    }

    public static IntPtr PackPoint(int x, int y) {
        return new IntPtr(((y & 0xffff) << 16) | (x & 0xffff));
    }

    public static void Post(IntPtr hwnd, uint message, long wParam, IntPtr lParam) {
        if (!PostMessageW(hwnd, message, new IntPtr(wParam), lParam)) {
            throw new InvalidOperationException("window_not_found: the window stopped accepting input");
        }
    }

    // Keyboard messages go to the control focused inside the target's own UI thread, which
    // Windows tracks per thread, so the target keeps its caret without becoming foreground.
    public static IntPtr KeyboardTarget(IntPtr top) {
        int processId;
        var threadId = GetWindowThreadProcessId(top, out processId);
        var info = new GUITHREADINFO();
        info.cbSize = Marshal.SizeOf(typeof(GUITHREADINFO));
        if (GetGUIThreadInfo(threadId, ref info) && info.hwndFocus != IntPtr.Zero && GetAncestor(info.hwndFocus, GA_ROOT) == top) {
            return info.hwndFocus;
        }
        return top;
    }

    public static IntPtr KeyLParam(int virtualKey, bool extended, bool keyUp, bool alt) {
        long scan = MapVirtualKeyW((uint)virtualKey, 0) & 0xff;
        long value = 1 | (scan << 16);
        if (extended) { value |= 1L << 24; }
        if (alt) { value |= 1L << 29; }
        if (keyUp) { value |= (1L << 30) | (1L << 31); }
        return new IntPtr(unchecked((int)value));
    }

    public static int VirtualKeyForChar(char character) {
        var scan = VkKeyScanW(character);
        return scan == -1 ? -1 : scan & 0xff;
    }
}
'@

$MaxNodes = 1200
$MaxDepth = 64
$TextLimit = 500
$MaxScreenshotPngBytes = 900000
$MaxScreenshotEdge = 1280
$MinScreenshotScale = 0.25
$ScreenshotScaleStep = 0.85
$BlockedAppFragments = @(
    "1password",
    "bitwarden",
    "dashlane",
    "lastpass",
    "nordpass",
    "proton pass"
)

$WindowsMessages = @{
    Char = 0x0102
    KeyDown = 0x0100
    KeyUp = 0x0101
    MouseMove = 0x0200
    LeftDown = 0x0201
    LeftUp = 0x0202
    RightDown = 0x0204
    RightUp = 0x0205
    MiddleDown = 0x0207
    MiddleUp = 0x0208
    Wheel = 0x020A
}

$MouseEvents = @{
    LeftDown = 0x0002
    LeftUp = 0x0004
    RightDown = 0x0008
    RightUp = 0x0010
    MiddleDown = 0x0020
    MiddleUp = 0x0040
    Wheel = 0x0800
    HorizontalWheel = 0x01000
}

function Write-OrcaJson($Payload) {
    $Payload | ConvertTo-Json -Depth 100 -Compress
}

function New-OrcaFrame([double]$X, [double]$Y, [double]$Width, [double]$Height) {
    if ($Width -le 0 -or $Height -le 0) { return $null }
    [pscustomobject]@{ x = $X; y = $Y; width = $Width; height = $Height }
}

function Read-OrcaOperation([string]$Path) {
    Get-Content -Raw -Encoding UTF8 -Path $Path | ConvertFrom-Json
}

function ConvertTo-OrcaLParam([int]$X, [int]$Y) {
    [IntPtr]((($Y -band 0xffff) -shl 16) -bor ($X -band 0xffff))
}

function ConvertTo-OrcaWheelParam([int]$Delta) {
    [IntPtr](($Delta -band 0xffff) -shl 16)
}

function Get-OrcaWindowProcesses {
    @(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | Sort-Object ProcessName, Id)
}

function Find-OrcaProcess([string]$Query) {
    $needle = ""
    if ($null -ne $Query) { $needle = $Query.Trim() }
    if ([string]::IsNullOrWhiteSpace($needle)) { throw 'appNotFound("")' }
    if ($needle.StartsWith("pid:", [System.StringComparison]::OrdinalIgnoreCase)) {
        $needle = $needle.Substring(4)
    }

    $parsedProcessId = 0
    $processes = Get-OrcaWindowProcesses
    if ([int]::TryParse($needle, [ref]$parsedProcessId)) {
        $match = $processes | Where-Object { $_.Id -eq $parsedProcessId } | Select-Object -First 1
        if ($null -ne $match) {
            Assert-OrcaProcessAllowed $match
            return $match
        }
    }

    $processNeedle = $needle
    if ($processNeedle.EndsWith(".exe", [System.StringComparison]::OrdinalIgnoreCase)) {
        $processNeedle = $processNeedle.Substring(0, $processNeedle.Length - 4)
    }

    $match = $processes | Where-Object {
        $_.ProcessName -ieq $processNeedle -or
        "$($_.ProcessName).exe" -ieq $needle -or
        $_.MainWindowTitle -ieq $needle -or
        $_.MainWindowTitle -ilike "*$needle*"
    } | Select-Object -First 1
    if ($null -ne $match) {
        Assert-OrcaProcessAllowed $match
        return $match
    }

    throw "appNotFound(`"$Query`")"
}

function Assert-OrcaProcessAllowed($Process) {
    $values = @($Process.ProcessName, $Process.MainWindowTitle) | ForEach-Object { ([string]$_).ToLowerInvariant() }
    foreach ($fragment in $BlockedAppFragments) {
        foreach ($value in $values) {
            if ($value.Contains($fragment)) {
                throw "appBlocked(`"$($Process.ProcessName)`")"
            }
        }
    }
}

function Test-OrcaBrowserProcess($Process) {
    $name = ([string]$Process.ProcessName).ToLowerInvariant()
    $browserProcesses = @(
        "arc",
        "brave",
        "chrome",
        "chromium",
        "firefox",
        "librewolf",
        "msedge",
        "opera",
        "vivaldi",
        "zen"
    )
    $browserProcesses -contains $name
}

function Get-OrcaRootElement($Process) {
    if ($Process.MainWindowHandle -eq 0) {
        throw "No top-level UI Automation window is available for $($Process.ProcessName)."
    }
    [Windows.Automation.AutomationElement]::FromHandle([IntPtr]$Process.MainWindowHandle)
}

function Get-OrcaWindowFrame($Process, $RootElement) {
    $rect = New-Object OrcaDesktopWin32+RECT
    if ([OrcaDesktopWin32]::GetWindowRect([IntPtr]$Process.MainWindowHandle, [ref]$rect)) {
        return New-OrcaFrame $rect.Left $rect.Top ($rect.Right - $rect.Left) ($rect.Bottom - $rect.Top)
    }

    try {
        $bounds = $RootElement.Current.BoundingRectangle
        if (-not $bounds.IsEmpty) {
            return New-OrcaFrame $bounds.X $bounds.Y $bounds.Width $bounds.Height
        }
    } catch {}
    $null
}

function Get-OrcaWindowId($Process) {
    [int64]$Process.MainWindowHandle
}

function Get-OrcaAppName($Process) {
    if ($Process.ProcessName -eq "ApplicationFrameHost" -and -not [string]::IsNullOrWhiteSpace($Process.MainWindowTitle)) {
        return [string]$Process.MainWindowTitle
    }
    [string]$Process.ProcessName
}

function New-OrcaAppRecord($Process) {
    [pscustomobject]@{
        name = Get-OrcaAppName $Process
        bundleIdentifier = $Process.ProcessName
        bundleId = $Process.ProcessName
        pid = [int]$Process.Id
    }
}

function Assert-OrcaWindowTarget($Process, $WindowId, $WindowIndex) {
    if ($null -ne $WindowIndex -and [int]$WindowIndex -ne 0) {
        throw "windowNotFound(`"$WindowIndex`")"
    }
    if ($null -ne $WindowId -and [int64]$WindowId -ne (Get-OrcaWindowId $Process)) {
        throw "windowNotFound(`"$WindowId`")"
    }
}

function Restore-OrcaWindow($Process) {
    if ($Process.MainWindowHandle -eq 0) { return }
    [void][OrcaDesktopWin32]::ShowWindow([IntPtr]$Process.MainWindowHandle, 9)
    [void][OrcaDesktopWin32]::SetForegroundWindow([IntPtr]$Process.MainWindowHandle)
}

function Test-OrcaWindowFocused([IntPtr]$WindowHandle) {
    [OrcaDesktopWin32]::GetForegroundWindow() -eq $WindowHandle
}

function Wait-OrcaWindowFocused([IntPtr]$WindowHandle, [int]$TimeoutMilliseconds) {
    $stopwatch = [Diagnostics.Stopwatch]::StartNew()
    while ($stopwatch.ElapsedMilliseconds -lt $TimeoutMilliseconds) {
        if (Test-OrcaWindowFocused $WindowHandle) { return $true }
        Start-Sleep -Milliseconds 50
    }
    Test-OrcaWindowFocused $WindowHandle
}

function Assert-OrcaKeyboardFocus([IntPtr]$WindowHandle, $Operation) {
    if (Test-OrcaWindowFocused $WindowHandle) { return }
    if ([bool]$Operation.restoreWindow) {
        if (Wait-OrcaWindowFocused $WindowHandle 500) { return }
        throw "window_not_focused: keyboard input requires the target window to be focused; restoreWindow was requested but the target window is still not focused; bring it forward manually or check desktop permissions"
    }
    throw "window_not_focused: keyboard input requires the target window to be focused; retry with --restore-window"
}

function Get-OrcaElementFrame($Element, $WindowFrame) {
    try {
        $bounds = $Element.Current.BoundingRectangle
        if ($bounds.IsEmpty) { return $null }
        if ($null -eq $WindowFrame) {
            return New-OrcaFrame $bounds.X $bounds.Y $bounds.Width $bounds.Height
        }
        New-OrcaFrame ($bounds.X - $WindowFrame.x) ($bounds.Y - $WindowFrame.y) $bounds.Width $bounds.Height
    } catch {
        $null
    }
}

function Get-OrcaProperty($Element, [string]$Name) {
    try { [string]$Element.Current.$Name } catch { "" }
}

function Get-OrcaRuntimeId($Element) {
    try { @($Element.GetRuntimeId()) } catch { @() }
}

function Test-OrcaSensitiveElement($Element) {
    try {
        if ($Element.Current.IsPassword) { return $true }
    } catch {}
    $controlType = try { [string]$Element.Current.ControlType.ProgrammaticName } catch { "" }
    $parts = @(
        (Get-OrcaProperty $Element "LocalizedControlType"),
        $controlType,
        (Get-OrcaProperty $Element "Name"),
        (Get-OrcaProperty $Element "AutomationId"),
        (Get-OrcaProperty $Element "ClassName")
    )
    $haystack = (($parts -join " ") -replace "\s+", " ").ToLowerInvariant()
    foreach ($term in @("password", "passcode", "secret", "one-time code", "verification code")) {
        if ($haystack.Contains($term)) { return $true }
    }
    $haystack -match "(^|[^a-z0-9])pin([^a-z0-9]|$)"
}

function Get-OrcaValueText($Element) {
    try {
        if (Test-OrcaSensitiveElement $Element) { return "[redacted]" }
        $pattern = $Element.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern)
        $rawValue = $pattern.Current.Value
        $text = if ($null -eq $rawValue) { "" } else { [string]$rawValue }
        if ($text.Length -gt $TextLimit) { return $text.Substring(0, $TextLimit) + "..." }
        $text
    } catch {
        ""
    }
}

function Get-OrcaActions($Element) {
    $actions = New-Object System.Collections.Generic.List[string]
    foreach ($pattern in $Element.GetSupportedPatterns()) {
        $name = [string]$pattern.ProgrammaticName
        if ($name -like "InvokePatternIdentifiers.Pattern") { $actions.Add("Invoke") }
        elseif ($name -like "TogglePatternIdentifiers.Pattern") { $actions.Add("Toggle") }
        elseif ($name -like "SelectionItemPatternIdentifiers.Pattern") { $actions.Add("Select") }
        elseif ($name -like "ScrollPatternIdentifiers.Pattern") { $actions.Add("Scroll") }
        elseif ($name -like "ValuePatternIdentifiers.Pattern") { $actions.Add("SetValue") }
    }
    @($actions | Select-Object -Unique)
}

function Get-OrcaMeaningfulActions($Actions) {
    $noisy = @("Invoke", "ScrollToVisible", "ShowMenu")
    @($Actions | Where-Object { $noisy -notcontains $_ })
}

function Format-OrcaSnapshotText([string]$Text) {
    if ([string]::IsNullOrWhiteSpace($Text)) { return "" }
    (($Text -replace "\s+", " ").Trim())
}

function Format-OrcaValueSegment([string]$RoleKey, [string]$Title, [string]$Value) {
    $clean = Format-OrcaSnapshotText $Value
    if ([string]::IsNullOrWhiteSpace($clean) -or $clean -eq $Title) { return "" }
    if ($RoleKey -eq "heading" -and $clean -match "^\d+$") { return "" }
    if ($RoleKey -in @("text", "edit", "document", "scroll bar", "progress bar")) {
        return " $clean"
    }
    ", Value: $clean"
}

function Test-OrcaSuppressChildren([string]$RoleKey, [string]$Title, [string]$Value, [string]$Summary) {
    $hasCompactLabel = -not [string]::IsNullOrWhiteSpace($Title) -or -not [string]::IsNullOrWhiteSpace((Format-OrcaSnapshotText $Value)) -or -not [string]::IsNullOrWhiteSpace((Format-OrcaSnapshotText $Summary))
    $hasCompactLabel -and $RoleKey -in @(
        "button",
        "check box",
        "combo box",
        "heading",
        "hyperlink",
        "link",
        "menu item",
        "radio button",
        "tab item"
    )
}

function Get-OrcaTextSnippets($Element, [int]$Limit = 6, [int]$MaxDepth = 3) {
    $values = New-Object System.Collections.Generic.List[string]
    $seen = New-Object System.Collections.Generic.HashSet[string]

    function Visit-OrcaText($Node, [int]$Depth) {
        if ($values.Count -ge $Limit -or $Depth -gt $MaxDepth) { return }
        $role = try { [string]$Node.Current.LocalizedControlType } catch { "" }
        if ($role -match "text|link|label") {
            foreach ($raw in @((Get-OrcaProperty $Node "Name"), (Get-OrcaValueText $Node))) {
                $value = (($raw -replace "\s+", " ").Trim())
                if (-not [string]::IsNullOrWhiteSpace($value) -and $seen.Add($value)) {
                    if ($value.Length -gt 80) { $value = $value.Substring(0, 80) + "..." }
                    $values.Add($value)
                    if ($values.Count -ge $Limit) { return }
                }
            }
        }
        try {
            $children = $Node.FindAll([Windows.Automation.TreeScope]::Children, [Windows.Automation.Condition]::TrueCondition)
            for ($i = 0; $i -lt $children.Count; $i++) {
                Visit-OrcaText $children.Item($i) ($Depth + 1)
                if ($values.Count -ge $Limit) { return }
            }
        } catch {}
    }

    Visit-OrcaText $Element 0
    @($values.ToArray())
}

function Test-OrcaPlainTextSubtree($Element, [int]$MaxDepth = 4) {
    $script:sawOrcaText = $false
    $allowed = @("pane", "group", "custom", "unknown", "text", "link", "image")

    function Visit-OrcaPlainText($Node, [int]$Depth) {
        if ($Depth -gt $MaxDepth) { return $false }
        $role = try { [string]$Node.Current.LocalizedControlType } catch { "" }
        $roleKey = $role.ToLowerInvariant()
        if ($allowed -notcontains $roleKey) { return $false }
        if ($roleKey -match "text|link") { $script:sawOrcaText = $true }
        if (@(Get-OrcaMeaningfulActions @(Get-OrcaActions $Node)).Count -gt 0) { return $false }
        try {
            $children = $Node.FindAll([Windows.Automation.TreeScope]::Children, [Windows.Automation.Condition]::TrueCondition)
            for ($i = 0; $i -lt $children.Count; $i++) {
                if (-not (Visit-OrcaPlainText $children.Item($i) ($Depth + 1))) { return $false }
            }
        } catch {}
        return $true
    }

    (Visit-OrcaPlainText $Element 0) -and $script:sawOrcaText
}

function New-OrcaElementRecord($Element, [int]$Index, $WindowFrame) {
    $controlType = try { [string]$Element.Current.ControlType.ProgrammaticName } catch { "" }
    $nativeWindowHandle = try { [int64]$Element.Current.NativeWindowHandle } catch { 0 }
    [pscustomobject]@{
        index = $Index
        runtimeId = @(Get-OrcaRuntimeId $Element)
        automationId = Get-OrcaProperty $Element "AutomationId"
        name = Get-OrcaProperty $Element "Name"
        controlType = $controlType
        localizedControlType = Get-OrcaProperty $Element "LocalizedControlType"
        className = Get-OrcaProperty $Element "ClassName"
        value = Get-OrcaValueText $Element
        isSelected = Test-OrcaElementSelected $Element
        nativeWindowHandle = $nativeWindowHandle
        frame = Get-OrcaElementFrame $Element $WindowFrame
        actions = @(Get-OrcaActions $Element)
    }
}

function Test-OrcaElementSelected($Element) {
    try {
        $pattern = $Element.GetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern)
        return [bool]$pattern.Current.IsSelected
    } catch {
        return $false
    }
}

function Render-OrcaTree($RootElement, $WindowFrame, [bool]$CompactBrowserTabs = $false) {
    $records = New-Object System.Collections.Generic.List[object]
    $lines = New-Object System.Collections.Generic.List[string]
    $seen = New-Object System.Collections.Generic.HashSet[string]
    $truncation = [pscustomobject]@{
        truncated = $false
        maxNodes = $MaxNodes
        maxDepth = $MaxDepth
        maxDepthReached = $false
    }

    function Visit-OrcaNode($Node, [int]$Depth) {
        if ($records.Count -ge $MaxNodes -or $Depth -gt $MaxDepth) {
            $truncation.truncated = $true
            if ($Depth -gt $MaxDepth) { $truncation.maxDepthReached = $true }
            return
        }
        $identity = try { (@($Node.GetRuntimeId()) -join ".") } catch { [Guid]::NewGuid().ToString() }
        if (-not $seen.Add($identity)) { return }

        $record = New-OrcaElementRecord $Node $records.Count $WindowFrame
        $children = @()
        try {
            $children = @($Node.FindAll([Windows.Automation.TreeScope]::Children, [Windows.Automation.Condition]::TrueCondition))
        } catch {}
        $meaningfulActions = @(Get-OrcaMeaningfulActions $record.actions)
        $title = if ([string]::IsNullOrWhiteSpace($record.name)) { $record.automationId } else { $record.name }
        $role = if ([string]::IsNullOrWhiteSpace($record.localizedControlType)) { $record.controlType } else { $record.localizedControlType }
        $roleKey = $role.ToLowerInvariant()
        $genericSummary = $null
        if (($roleKey -in @("pane", "group", "custom", "unknown")) -and [string]::IsNullOrWhiteSpace($title) -and [string]::IsNullOrWhiteSpace($record.value)) {
            $snippets = @(Get-OrcaTextSnippets $Node 8 4)
            if ($snippets.Count -ge 2 -and (Test-OrcaPlainTextSubtree $Node)) {
                $genericSummary = ($snippets -join " ")
            }
        }
        if (($roleKey -in @("pane", "group", "custom", "unknown")) -and [string]::IsNullOrWhiteSpace($title) -and [string]::IsNullOrWhiteSpace($record.value) -and $meaningfulActions.Count -eq 0 -and $null -eq $genericSummary -and $children.Count -le 1) {
            for ($i = 0; $i -lt $children.Count; $i++) {
                Visit-OrcaNode $children.Item($i) $Depth
            }
            return
        }

        $records.Add($record)

        $line = "$($record.index) $role $(Format-OrcaSnapshotText $title)".TrimEnd()
        $line += Format-OrcaValueSegment $roleKey $title $record.value
        if (-not [string]::IsNullOrWhiteSpace($genericSummary) -and $genericSummary -ne $title) {
            $line += ", Text: " + (Format-OrcaSnapshotText $genericSummary)
        } elseif ($roleKey -in @("row", "data item", "list item")) {
            $rowSummary = @((Get-OrcaTextSnippets $Node 6 3)) -join " "
            if (-not [string]::IsNullOrWhiteSpace($rowSummary) -and $rowSummary -ne $title) {
                $line += ", Text: " + (Format-OrcaSnapshotText $rowSummary)
            }
        }
        if ($meaningfulActions.Count -gt 0) {
            $line += ", Secondary Actions: " + ($meaningfulActions -join ", ")
        }
        $lines.Add(("`t" * $Depth) + $line)

        if (-not [string]::IsNullOrWhiteSpace($genericSummary) -or (Test-OrcaSuppressChildren $roleKey $title $record.value $genericSummary)) { return }
        $childLineStart = $lines.Count
        for ($i = 0; $i -lt $children.Count; $i++) {
            Visit-OrcaNode $children.Item($i) ($Depth + 1)
        }
        if ($CompactBrowserTabs) {
            Compress-OrcaRenderedBrowserTabs $records $lines $childLineStart ($Depth + 1)
        }
    }

    Visit-OrcaNode $RootElement 0
    [pscustomobject]@{ elements = @($records.ToArray()); lines = @($lines.ToArray()); truncation = $truncation }
}

function Compress-OrcaRenderedBrowserTabs($Records, $Lines, [int]$StartLine, [int]$Depth) {
    $tabLineIndexes = New-Object System.Collections.Generic.List[int]
    for ($lineIndex = $StartLine; $lineIndex -lt $Lines.Count; $lineIndex++) {
        if (Test-OrcaDirectRenderedBrowserTabLine ([string]$Lines[$lineIndex]) $Depth) {
            $tabLineIndexes.Add($lineIndex)
        }
    }
    if ($tabLineIndexes.Count -lt 10) { return }

    $recordsByIndex = @{}
    foreach ($record in @($Records.ToArray())) {
        $recordsByIndex[[int]$record.index] = $record
    }
    $activeLineIndexes = New-Object System.Collections.Generic.HashSet[int]
    foreach ($lineIndex in $tabLineIndexes) {
        if (Test-OrcaActiveRenderedBrowserTabLine ([string]$Lines[$lineIndex]) $Depth $recordsByIndex) {
            [void]$activeLineIndexes.Add($lineIndex)
        }
    }
    if ($activeLineIndexes.Count -eq 0) { return }

    $omittedRecordIndexes = New-Object System.Collections.Generic.HashSet[int]
    $omittedCount = 0
    $insertionIndex = $tabLineIndexes[0]
    for ($i = $tabLineIndexes.Count - 1; $i -ge 0; $i--) {
        $lineIndex = $tabLineIndexes[$i]
        if ($activeLineIndexes.Contains($lineIndex)) { continue }
        $recordIndex = Get-OrcaRenderedElementIndex ([string]$Lines[$lineIndex]) $Depth
        if ($null -ne $recordIndex) {
            [void]$omittedRecordIndexes.Add([int]$recordIndex)
        }
        $Lines.RemoveAt($lineIndex)
        $omittedCount++
    }
    if ($omittedCount -le 0) { return }
    for ($recordIndex = $Records.Count - 1; $recordIndex -ge 0; $recordIndex--) {
        if ($omittedRecordIndexes.Contains([int]$Records[$recordIndex].index)) {
            $Records.RemoveAt($recordIndex)
        }
    }
    $Lines.Insert($insertionIndex, (("`t" * $Depth) + "... $omittedCount inactive browser tabs omitted"))
}

function Test-OrcaDirectRenderedBrowserTabLine([string]$Line, [int]$Depth) {
    $indent = "`t" * $Depth
    if (-not $Line.StartsWith($indent)) { return $false }
    $text = $Line.Substring($indent.Length)
    if ($text.StartsWith("`t")) { return $false }
    $text -match "^\d+ (page tab|tab item|tab)($|[ \(,])"
}

function Test-OrcaActiveRenderedBrowserTabLine([string]$Line, [int]$Depth, $RecordsByIndex) {
    if ($Line.Contains("(selected")) { return $true }
    $recordIndex = Get-OrcaRenderedElementIndex $Line $Depth
    if ($null -eq $recordIndex -or -not $RecordsByIndex.ContainsKey([int]$recordIndex)) { return $false }
    $record = $RecordsByIndex[[int]$recordIndex]
    [bool]$record.isSelected -or (Format-OrcaSnapshotText $record.value) -eq "1"
}

function Get-OrcaRenderedElementIndex([string]$Line, [int]$Depth) {
    $text = $Line.Substring(("`t" * $Depth).Length)
    if ($text -match "^(\d+)") { return [int]$Matches[1] }
    $null
}

function ConvertTo-OrcaPngBytes([System.Drawing.Image]$Image) {
    $stream = $null
    try {
        $stream = New-Object System.IO.MemoryStream
        $Image.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
        return ,$stream.ToArray()
    } finally {
        if ($null -ne $stream) { $stream.Dispose() }
    }
}

function New-OrcaScreenshotPayload([byte[]]$Bytes, [int]$Width, [int]$Height, [double]$Scale) {
    [pscustomobject]@{
        base64 = [Convert]::ToBase64String($Bytes)
        width = $Width
        height = $Height
        scale = $Scale
    }
}

function Resize-OrcaBitmap([System.Drawing.Bitmap]$Source, [int]$Width, [int]$Height) {
    $resized = $null
    $graphics = $null
    try {
        $resized = New-Object System.Drawing.Bitmap $Width, $Height
        $graphics = [System.Drawing.Graphics]::FromImage($resized)
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::Bilinear
        $graphics.DrawImage($Source, 0, 0, $Width, $Height)
        $result = $resized
        $resized = $null
        return $result
    } finally {
        if ($null -ne $graphics) { $graphics.Dispose() }
        if ($null -ne $resized) { $resized.Dispose() }
    }
}

function Get-OrcaBoundedScreenshotPayload([System.Drawing.Bitmap]$Bitmap) {
    $originalWidth = [int][Math]::Max(1, $Bitmap.Width)
    $originalHeight = [int][Math]::Max(1, $Bitmap.Height)
    $pngBytes = ConvertTo-OrcaPngBytes $Bitmap
    if ($pngBytes.Length -le $MaxScreenshotPngBytes) {
        return New-OrcaScreenshotPayload $pngBytes $originalWidth $originalHeight 1.0
    }

    # Why: screenshots cross process boundaries as PNG base64 in JSON; cap noisy
    # large-window payloads to match the macOS provider's memory bounds.
    $scale = [Math]::Min(1.0, $MaxScreenshotEdge / [double][Math]::Max($originalWidth, $originalHeight))
    while ($scale -ge $MinScreenshotScale) {
        $width = [int][Math]::Max(1, [Math]::Round($originalWidth * $scale))
        $height = [int][Math]::Max(1, [Math]::Round($originalHeight * $scale))
        if ($width -eq $originalWidth -and $height -eq $originalHeight) {
            $scale *= $ScreenshotScaleStep
            continue
        }

        $resized = $null
        try {
            $resized = Resize-OrcaBitmap $Bitmap $width $height
            $candidateBytes = ConvertTo-OrcaPngBytes $resized
            if ($candidateBytes.Length -le $MaxScreenshotPngBytes) {
                return New-OrcaScreenshotPayload $candidateBytes $width $height ($width / [double]$originalWidth)
            }
        } finally {
            if ($null -ne $resized) { $resized.Dispose() }
        }

        $scale *= $ScreenshotScaleStep
    }

    [pscustomobject]@{
        error = [pscustomobject]@{
            code = "screenshot_failed"
            message = "screenshot exceeded the computer-use payload cap after downscaling; retry with --no-screenshot or target a smaller window"
        }
    }
}

function Get-OrcaScreenshot([bool]$IncludeScreenshot, $WindowFrame) {
    if (-not $IncludeScreenshot -or $null -eq $WindowFrame) { return $null }
    $bitmap = $null
    $graphics = $null
    try {
        $width = [int][Math]::Max(1, [Math]::Round($WindowFrame.width))
        $height = [int][Math]::Max(1, [Math]::Round($WindowFrame.height))
        $bitmap = New-Object System.Drawing.Bitmap $width, $height
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $graphics.CopyFromScreen([int][Math]::Round($WindowFrame.x), [int][Math]::Round($WindowFrame.y), 0, 0, $bitmap.Size)
        Get-OrcaBoundedScreenshotPayload $bitmap
    } catch {
        $null
    } finally {
        if ($null -ne $graphics) { $graphics.Dispose() }
        if ($null -ne $bitmap) { $bitmap.Dispose() }
    }
}

function New-OrcaSnapshot([string]$Query, [bool]$IncludeScreenshot, $WindowId = $null, $WindowIndex = $null, [bool]$RestoreWindow = $false) {
    $process = Find-OrcaProcess $Query
    if ($RestoreWindow) { Restore-OrcaWindow $process }
    Assert-OrcaWindowTarget $process $WindowId $WindowIndex
    $root = Get-OrcaRootElement $process
    $windowFrame = Get-OrcaWindowFrame $process $root
    $tree = Render-OrcaTree $root $windowFrame (Test-OrcaBrowserProcess $process)
    $screenshot = Get-OrcaScreenshot $IncludeScreenshot $windowFrame

    [pscustomobject]@{
        snapshotId = [guid]::NewGuid().ToString()
        app = New-OrcaAppRecord $process
        windowTitle = $process.MainWindowTitle
        windowId = Get-OrcaWindowId $process
        windowBounds = $windowFrame
        screenshotPngBase64 = if ($null -ne $screenshot) { $screenshot.base64 } else { $null }
        screenshotWidth = if ($null -ne $screenshot) { $screenshot.width } else { $null }
        screenshotHeight = if ($null -ne $screenshot) { $screenshot.height } else { $null }
        screenshotScale = if ($null -ne $screenshot) { $screenshot.scale } else { $null }
        screenshotError = if ($null -ne $screenshot) { $screenshot.error } else { $null }
        coordinateSpace = "window"
        truncation = $tree.truncation
        treeLines = @($tree.lines)
        focusedSummary = $null
        focusedElementId = $null
        selectedText = $null
        elements = @($tree.elements)
    }
}

function Get-OrcaAppList {
    @(Get-OrcaWindowProcesses | ForEach-Object {
        New-OrcaAppRecord $_
    })
}

function Get-OrcaWindowList([string]$Query) {
    $process = Find-OrcaProcess $Query
    $root = Get-OrcaRootElement $process
    $windowFrame = Get-OrcaWindowFrame $process $root
    $x = $null
    $y = $null
    $width = 0
    $height = 0
    if ($null -ne $windowFrame) {
        $x = [int][Math]::Round($windowFrame.x)
        $y = [int][Math]::Round($windowFrame.y)
        $width = [int][Math]::Max(0, [Math]::Round($windowFrame.width))
        $height = [int][Math]::Max(0, [Math]::Round($windowFrame.height))
    }
    $app = New-OrcaAppRecord $process
    [pscustomobject]@{
        app = $app
        windows = @([pscustomobject]@{
            index = 0
            app = $app
            id = Get-OrcaWindowId $process
            title = $process.MainWindowTitle
            x = $x
            y = $y
            width = $width
            height = $height
            isMinimized = $false
            isOffscreen = $false
            screenIndex = $null
            platform = [pscustomobject]@{ backend = "uia"; nativeWindowHandle = Get-OrcaWindowId $process }
        })
    }
}

function Get-OrcaHandshake {
    [pscustomobject]@{
        platform = "win32"
        provider = "orca-computer-use-windows"
        providerVersion = "1.0.0"
        protocolVersion = 1
        supports = [pscustomobject]@{
            apps = [pscustomobject]@{ list = $true; bundleIds = $false; pids = $true }
            windows = [pscustomobject]@{ list = $true; targetById = $true; targetByIndex = $true; focus = $false; moveResize = $false }
            observation = [pscustomobject]@{ screenshot = $true; annotatedScreenshot = $false; elementFrames = $true; ocr = $false }
            actions = [pscustomobject]@{
                click = $true
                typeText = $true
                pressKey = $true
                hotkey = $true
                pasteText = $true
                scroll = $true
                drag = $true
                setValue = $true
                performAction = $true
            }
            surfaces = [pscustomobject]@{ menus = $false; dialogs = $false; dock = $false; menubar = $false }
        }
    }
}

function Test-OrcaSameRuntimeId($Left, $Right) {
    if ($null -eq $Left -or $null -eq $Right -or $Left.Count -ne $Right.Count) { return $false }
    for ($i = 0; $i -lt $Left.Count; $i++) {
        if ([int]$Left[$i] -ne [int]$Right[$i]) { return $false }
    }
    $true
}

function Find-OrcaElement($RootElement, $Record) {
    if ($null -eq $Record) { return $null }
    if ($Record.index -eq 0) { return $RootElement }

    try {
        $descendants = $RootElement.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition)
        for ($i = 0; $i -lt $descendants.Count; $i++) {
            $candidate = $descendants.Item($i)
            if (Test-OrcaSameRuntimeId @($candidate.GetRuntimeId()) @($Record.runtimeId)) {
                return $candidate
            }
        }
    } catch {}
    $null
}

function Invoke-OrcaPrimaryAction($Element) {
    foreach ($pattern in @(
        [Windows.Automation.InvokePattern]::Pattern,
        [Windows.Automation.SelectionItemPattern]::Pattern,
        [Windows.Automation.TogglePattern]::Pattern
    )) {
        try {
            $instance = $Element.GetCurrentPattern($pattern)
            if ($pattern -eq [Windows.Automation.InvokePattern]::Pattern) { $instance.Invoke(); return $true }
            if ($pattern -eq [Windows.Automation.SelectionItemPattern]::Pattern) { $instance.Select(); return $true }
            if ($pattern -eq [Windows.Automation.TogglePattern]::Pattern) { $instance.Toggle(); return $true }
        } catch {}
    }
    $false
}

function Invoke-OrcaNamedAction($Element, [string]$Action) {
    $wanted = ""
    if ($null -ne $Action) { $wanted = $Action.Trim().ToLowerInvariant() }
    switch ($wanted) {
        "invoke" {
            $pattern = $Element.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern)
            $pattern.Invoke()
            return $true
        }
        "select" {
            $pattern = $Element.GetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern)
            $pattern.Select()
            return $true
        }
        "toggle" {
            $pattern = $Element.GetCurrentPattern([Windows.Automation.TogglePattern]::Pattern)
            $pattern.Toggle()
            return $true
        }
        default {
            return $false
        }
    }
}

function Set-OrcaElementValue($Element, [string]$Value) {
    try {
        $pattern = $Element.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern)
        if (-not $pattern.Current.IsReadOnly) {
            $pattern.SetValue($Value)
            return $true
        }
    } catch {}
    $false
}

function Get-OrcaRequiredNumber($Value, [string]$Name) {
    if ($null -eq $Value) { throw "$Name is required" }
    $number = [double]$Value
    if ([double]::IsNaN($number) -or [double]::IsInfinity($number)) {
        throw "$Name must be a finite number"
    }
    $number
}

function Get-OrcaPositiveInteger($Value, [string]$Name) {
    if ($null -eq $Value) { $Value = 1 }
    $number = [int]$Value
    if ($number -le 0) { throw "$Name must be a positive integer" }
    $number
}

function Get-OrcaPositiveNumber($Value, [string]$Name) {
    if ($null -eq $Value) { $Value = 1 }
    $number = Get-OrcaRequiredNumber $Value $Name
    if ($number -le 0) { throw "$Name must be a positive number" }
    $number
}

function Get-OrcaRequiredString($Value, [string]$Name) {
    if ($null -eq $Value) { throw "$Name is required" }
    $text = [string]$Value
    if ($text.Length -eq 0) { throw "$Name is required" }
    $text
}

function Get-OrcaScreenPoint($Operation, $WindowFrame) {
    if ($null -ne $Operation.element) {
        throw "stale element frame; run get-app-state again and use a fresh element index"
    }
    $x = Get-OrcaRequiredNumber $Operation.x "x"
    $y = Get-OrcaRequiredNumber $Operation.y "y"
    @{
        x = [int][Math]::Round($WindowFrame.x + $x)
        y = [int][Math]::Round($WindowFrame.y + $y)
    }
}

function Get-OrcaElementScreenPoint($Element) {
    if ($null -eq $Element) { return $null }
    try {
        $rect = $Element.Current.BoundingRectangle
        if ($rect.Width -gt 0 -and $rect.Height -gt 0) {
            return @{
                x = [int][Math]::Round($rect.X + ($rect.Width / 2))
                y = [int][Math]::Round($rect.Y + ($rect.Height / 2))
            }
        }
    } catch {}
    $null
}

function Send-OrcaMouseClick([IntPtr]$WindowHandle, [int]$ScreenX, [int]$ScreenY, [string]$Button, [int]$Count, [string]$Modifiers) {
    [void][OrcaDesktopWin32]::SetForegroundWindow($WindowHandle)
    [void][OrcaDesktopWin32]::SetCursorPos($ScreenX, $ScreenY)
    $buttonName = if ([string]::IsNullOrWhiteSpace($Button)) { "left" } else { $Button.ToLowerInvariant() }
    switch ($buttonName) {
        "left" { $down = $MouseEvents.LeftDown; $up = $MouseEvents.LeftUp }
        "right" { $down = $MouseEvents.RightDown; $up = $MouseEvents.RightUp }
        "middle" { $down = $MouseEvents.MiddleDown; $up = $MouseEvents.MiddleUp }
        default { throw "unsupported mouse button: $Button" }
    }

    $modifierKeys = @(Get-OrcaClickModifierVirtualKeys $Modifiers)
    $clickCount = Get-OrcaPositiveInteger $Count "click_count"
    if ($modifierKeys.Count -eq 0) {
        for ($i = 0; $i -lt $clickCount; $i++) {
            [OrcaDesktopWin32]::mouse_event($down, 0, 0, 0, [UIntPtr]::Zero)
            Start-Sleep -Milliseconds 35
            [OrcaDesktopWin32]::mouse_event($up, 0, 0, 0, [UIntPtr]::Zero)
        }
        return
    }
    for ($i = 0; $i -lt $clickCount; $i++) {
        [OrcaDesktopWin32]::SendModifiedClick(
            [byte[]]$modifierKeys,
            [uint32]$down,
            [uint32]$up
        )
        if ($i + 1 -lt $clickCount) { Start-Sleep -Milliseconds 35 }
    }
}

function Send-OrcaDrag([IntPtr]$WindowHandle, $From, $To) {
    [void][OrcaDesktopWin32]::SetForegroundWindow($WindowHandle)
    $startX = [int]$From.x
    $startY = [int]$From.y
    $endX = [int]$To.x
    $endY = [int]$To.y
    [void][OrcaDesktopWin32]::SetCursorPos($startX, $startY)
    [OrcaDesktopWin32]::mouse_event($MouseEvents.LeftDown, 0, 0, 0, [UIntPtr]::Zero)
    for ($step = 1; $step -le 12; $step++) {
        $x = [int][Math]::Round($startX + (($endX - $startX) * $step / 12))
        $y = [int][Math]::Round($startY + (($endY - $startY) * $step / 12))
        [void][OrcaDesktopWin32]::SetCursorPos($x, $y)
        Start-Sleep -Milliseconds 20
    }
    [OrcaDesktopWin32]::mouse_event($MouseEvents.LeftUp, 0, 0, 0, [UIntPtr]::Zero)
}

function Send-OrcaText([IntPtr]$WindowHandle, [string]$Text) {
    [void][OrcaDesktopWin32]::SetForegroundWindow($WindowHandle)
    $hasNonAscii = $false
    foreach ($character in $Text.ToCharArray()) {
        if ([int][char]$character -gt 0x7F) { $hasNonAscii = $true; break }
    }
    if ($hasNonAscii) {
        foreach ($character in $Text.ToCharArray()) {
            [void][OrcaDesktopWin32]::PostMessage($WindowHandle, $WindowsMessages.Char, [IntPtr][int][char]$character, [IntPtr]::Zero)
            Start-Sleep -Milliseconds 8
        }
        return
    }
    [System.Windows.Forms.SendKeys]::SendWait((ConvertTo-OrcaSendKeysText $Text))
}

function Get-OrcaVirtualKey([string]$Key) {
    $normalized = $Key.ToLowerInvariant()
    $map = @{
        "return" = 0x0D; "enter" = 0x0D; "tab" = 0x09; "escape" = 0x1B; "esc" = 0x1B
        "backspace" = 0x08; "delete" = 0x2E; "space" = 0x20; "left" = 0x25
        "up" = 0x26; "right" = 0x27; "down" = 0x28; "home" = 0x24; "end" = 0x23
    }
    if ($map.ContainsKey($normalized)) { return $map[$normalized] }
    if ($normalized.Length -eq 1) { return [int][char]$normalized.ToUpperInvariant()[0] }
    throw "Unsupported key: $Key"
}

function Send-OrcaKey([IntPtr]$WindowHandle, [string]$Key) {
    [void][OrcaDesktopWin32]::SetForegroundWindow($WindowHandle)
    [System.Windows.Forms.SendKeys]::SendWait((ConvertTo-OrcaSendKeysKey $Key))
}

function Get-OrcaModifierVirtualKey([string]$Modifier) {
    switch ($Modifier.ToLowerInvariant()) {
        { $_ -in @("ctrl", "control", "cmdorctrl", "commandorcontrol") } { return 0x11 }
        { $_ -in @("shift") } { return 0x10 }
        { $_ -in @("alt", "option") } { return 0x12 }
        { $_ -in @("meta", "super", "win", "cmd", "command") } { return 0x5B }
        default { throw "Unsupported modifier: $Modifier" }
    }
}

function Get-OrcaClickModifierVirtualKeys([string]$Modifiers) {
    if ([string]::IsNullOrWhiteSpace($Modifiers)) { return @() }
    $parts = @($Modifiers.Split("+") | ForEach-Object { $_.Trim() })
    $emptyParts = @($parts | Where-Object { [string]::IsNullOrWhiteSpace($_) })
    if ($parts.Count -eq 0 -or $emptyParts.Count -gt 0) {
        throw "Click modifiers require modifier keys only"
    }
    @($parts | ForEach-Object { Get-OrcaModifierVirtualKey $_ })
}

function Send-OrcaHotkey([IntPtr]$WindowHandle, [string]$KeySpec) {
    $parts = @($KeySpec.Split("+") | ForEach-Object { $_.Trim() } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if ($parts.Count -eq 0) { throw "Unsupported key: $KeySpec" }
    $key = $parts[$parts.Count - 1]
    $prefix = ""
    if ($parts.Count -gt 1) {
        foreach ($modifier in $parts[0..($parts.Count - 2)]) {
            $prefix += ConvertTo-OrcaSendKeysModifier $modifier
        }
    }
    [void][OrcaDesktopWin32]::SetForegroundWindow($WindowHandle)
    [System.Windows.Forms.SendKeys]::SendWait($prefix + (ConvertTo-OrcaSendKeysKey $key))
}

function ConvertTo-OrcaSendKeysText([string]$Text) {
    $builder = New-Object System.Text.StringBuilder
    foreach ($character in $Text.ToCharArray()) {
        $value = [string]$character
        if ($value -eq "`r") { continue }
        if ($value -eq "`n") { [void]$builder.Append("{ENTER}"); continue }
        if ("+^%~(){}[]".Contains($value)) {
            [void]$builder.Append("{").Append($value).Append("}")
        } else {
            [void]$builder.Append($value)
        }
    }
    $builder.ToString()
}

function ConvertTo-OrcaSendKeysKey([string]$Key) {
    switch ($Key.ToLowerInvariant()) {
        { $_ -in @("return", "enter") } { return "{ENTER}" }
        "tab" { return "{TAB}" }
        { $_ -in @("escape", "esc") } { return "{ESC}" }
        "backspace" { return "{BACKSPACE}" }
        "delete" { return "{DELETE}" }
        "space" { return " " }
        "left" { return "{LEFT}" }
        "up" { return "{UP}" }
        "right" { return "{RIGHT}" }
        "down" { return "{DOWN}" }
        "home" { return "{HOME}" }
        "end" { return "{END}" }
        { $_ -in @("pageup", "page_up") } { return "{PGUP}" }
        { $_ -in @("pagedown", "page_down") } { return "{PGDN}" }
        "insert" { return "{INSERT}" }
        default {
            if ($Key.Length -eq 1) { return (ConvertTo-OrcaSendKeysText $Key) }
            throw "Unsupported key: $Key"
        }
    }
}

function ConvertTo-OrcaSendKeysModifier([string]$Modifier) {
    switch ($Modifier.ToLowerInvariant()) {
        { $_ -in @("ctrl", "control", "cmdorctrl", "commandorcontrol") } { return "^" }
        "shift" { return "+" }
        { $_ -in @("alt", "option") } { return "%" }
        default { throw "Unsupported modifier: $Modifier" }
    }
}

function Send-OrcaPasteText([IntPtr]$WindowHandle, [string]$Text) {
    $previous = $null
    $hadPrevious = $false
    try { $previous = [System.Windows.Forms.Clipboard]::GetDataObject() } catch {}
    $hadPrevious = $null -ne $previous
    try {
        Set-Clipboard -Value $Text
        Send-OrcaHotkey $WindowHandle "Ctrl+v"
    } finally {
        if ($hadPrevious) {
            try { [System.Windows.Forms.Clipboard]::SetDataObject($previous, $true) } catch {}
        } else {
            try { [System.Windows.Forms.Clipboard]::Clear() } catch {}
        }
    }
}

$DesktopAppMessages = @{
    KeyDown = 0x0100; KeyUp = 0x0101; Char = 0x0102; SysKeyDown = 0x0104; SysKeyUp = 0x0105
    MouseMove = 0x0200; LeftDown = 0x0201; LeftUp = 0x0202; LeftDouble = 0x0203
    RightDown = 0x0204; RightUp = 0x0205; RightDouble = 0x0206; Wheel = 0x020A; HorizontalWheel = 0x020E
}
# Why: navigation keys live on the extended keyboard block; without bit 24 some controls read
# them as numeric-keypad keys (e.g. Home becomes "7").
$DesktopAppExtendedKeys = @(0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2D, 0x2E)
$DesktopAppMaxWheelDelta = 10000

function Get-OrcaDesktopProcess([int]$ProcessId) {
    try { Get-Process -Id $ProcessId -ErrorAction Stop } catch { $null }
}

function Test-OrcaDesktopWindowAllowed($Process, [string]$Title) {
    try { Assert-OrcaProcessAllowed $Process } catch { return $false }
    $lowered = $Title.ToLowerInvariant()
    foreach ($fragment in $BlockedAppFragments) {
        if ($lowered.Contains($fragment)) { return $false }
    }
    $true
}

# Window list for the Desktop App pane: same shape as the macOS helper's `listDesktopWindows`.
function Get-OrcaDesktopWindows($ExcludePid) {
    $excluded = 0
    if ($null -ne $ExcludePid) { $excluded = [int]$ExcludePid }
    $processes = @{}
    $windows = New-Object System.Collections.Generic.List[object]
    foreach ($info in [OrcaDesktopAppWin32]::ListWindows()) {
        if ($info.ProcessId -eq $excluded -or $info.ProcessId -eq $PID) { continue }
        if ([string]::IsNullOrWhiteSpace($info.Title) -or $info.ClassName -in @("Progman", "WorkerW", "Shell_TrayWnd")) { continue }
        if ($info.Width -le 0 -or $info.Height -le 0) { continue }
        if (-not $processes.ContainsKey($info.ProcessId)) { $processes[$info.ProcessId] = Get-OrcaDesktopProcess $info.ProcessId }
        $process = $processes[$info.ProcessId]
        if ($null -eq $process -or -not (Test-OrcaDesktopWindowAllowed $process $info.Title)) { continue }
        $windows.Add([pscustomobject]@{
            windowId = [int64]$info.Handle
            pid = [int]$info.ProcessId
            appName = Get-OrcaAppName $process
            bundleId = [string]$process.ProcessName
            title = [string]$info.Title
            bounds = [pscustomobject]@{ x = $info.X; y = $info.Y; width = $info.Width; height = $info.Height }
        })
    }
    @($windows.ToArray())
}

# Why not Get-OrcaPositiveInteger: it defaults a missing value to 1, and pid 1 or window 1
# must never be targeted by accident.
function Get-OrcaDesktopId($Value, [string]$Name) {
    if ($null -eq $Value) { throw "$Name is required" }
    $number = [int64]$Value
    if ($number -le 0) { throw "$Name must be a positive integer" }
    $number
}

function Resolve-OrcaDesktopTarget($Operation) {
    $processId = [int](Get-OrcaDesktopId $Operation.pid "pid")
    $windowId = Get-OrcaDesktopId $Operation.windowId "windowId"
    $handle = [IntPtr]$windowId
    if (-not [OrcaDesktopAppWin32]::IsTopLevel($handle)) { throw "window_not_found: window $windowId is gone" }
    $info = [OrcaDesktopAppWin32]::Describe($handle)
    if ($null -eq $info -or $info.ProcessId -ne $processId) { throw "window_not_found: window $windowId does not belong to pid $processId" }
    $process = Get-OrcaDesktopProcess $processId
    if ($null -eq $process) { throw "appNotFound(`"$processId`")" }
    if (-not (Test-OrcaDesktopWindowAllowed $process $info.Title)) { throw "appBlocked(`"$($process.ProcessName)`")" }
    [pscustomobject]@{ handle = $handle; info = $info }
}

function Get-OrcaDesktopScreenPoint($Target, $Payload) {
    $x = Get-OrcaRequiredNumber $Payload.x "x"
    $y = Get-OrcaRequiredNumber $Payload.y "y"
    # Why: input is window-relative like the macOS helper; a point outside the window would
    # land on whatever app happens to sit there.
    if ($x -lt 0 -or $y -lt 0 -or $x -ge $Target.info.Width -or $y -ge $Target.info.Height) {
        throw "invalid_argument: point ($x, $y) is outside the window"
    }
    [pscustomobject]@{ x = [int][Math]::Round($Target.info.X + $x); y = [int][Math]::Round($Target.info.Y + $y) }
}

function Send-OrcaDesktopClick($Target, $Payload) {
    $point = Get-OrcaDesktopScreenPoint $Target $Payload
    $count = Get-OrcaPositiveInteger $Payload.clickCount "clickCount"
    if ($count -gt 3) { throw "invalid_argument: clickCount must be 1 to 3" }
    $isRight = $Payload.button -eq "right"
    if (-not $isRight -and $Payload.button -ne "left") { throw "unsupported mouse button: $($Payload.button)" }
    $down = if ($isRight) { $DesktopAppMessages.RightDown } else { $DesktopAppMessages.LeftDown }
    $up = if ($isRight) { $DesktopAppMessages.RightUp } else { $DesktopAppMessages.LeftUp }
    $double = if ($isRight) { $DesktopAppMessages.RightDouble } else { $DesktopAppMessages.LeftDouble }
    $buttonFlag = if ($isRight) { 0x0002 } else { 0x0001 }
    $child = [OrcaDesktopAppWin32]::ChildAt($Target.handle, $point.x, $point.y)
    $lParam = [OrcaDesktopAppWin32]::ClientLParam($child, $point.x, $point.y)
    [OrcaDesktopAppWin32]::Post($child, $DesktopAppMessages.MouseMove, 0, $lParam)
    # Why one press: the pane sends one click per real press, with clickCount as that press's
    # position in the sequence. Real double clicks arrive as down, up, DBLCLK, up, so the
    # second press is the DBLCLK message.
    $message = Get-OrcaDesktopPressMessage $count $down $double
    [OrcaDesktopAppWin32]::Post($child, $message, $buttonFlag, $lParam)
    [OrcaDesktopAppWin32]::Post($child, $up, 0, $lParam)
}

function Get-OrcaDesktopPressMessage([int]$Count, [uint32]$Down, [uint32]$Double) {
    if ($Count -eq 2) { $Double } else { $Down }
}

function Send-OrcaDesktopScroll($Target, $Payload) {
    $point = Get-OrcaDesktopScreenPoint $Target $Payload
    $deltaX = Get-OrcaRequiredNumber $Payload.deltaX "deltaX"
    $deltaY = Get-OrcaRequiredNumber $Payload.deltaY "deltaY"
    $child = [OrcaDesktopAppWin32]::ChildAt($Target.handle, $point.x, $point.y)
    # Why: wheel messages carry screen coordinates, unlike button messages.
    $lParam = [OrcaDesktopAppWin32]::ScreenLParam($child, $point.x, $point.y)
    # Pixel deltas from the pane become wheel units (120 per notch, about 100 px); the sign is
    # flipped for vertical because WM_MOUSEWHEEL treats positive as "away from the user".
    $vertical = [int][Math]::Max(-$DesktopAppMaxWheelDelta, [Math]::Min($DesktopAppMaxWheelDelta, [Math]::Round(-$deltaY * 1.2)))
    $horizontal = [int][Math]::Max(-$DesktopAppMaxWheelDelta, [Math]::Min($DesktopAppMaxWheelDelta, [Math]::Round($deltaX * 1.2)))
    if ($vertical -ne 0) { [OrcaDesktopAppWin32]::Post($child, $DesktopAppMessages.Wheel, (($vertical -band 0xffff) -shl 16), $lParam) }
    if ($horizontal -ne 0) { [OrcaDesktopAppWin32]::Post($child, $DesktopAppMessages.HorizontalWheel, (($horizontal -band 0xffff) -shl 16), $lParam) }
}

function Send-OrcaDesktopText($Target, [string]$Text) {
    $focus = [OrcaDesktopAppWin32]::KeyboardTarget($Target.handle)
    foreach ($character in $Text.ToCharArray()) {
        if ($character -eq "`r") { continue }
        $code = if ($character -eq "`n") { 0x0D } else { [int][char]$character }
        [OrcaDesktopAppWin32]::Post($focus, $DesktopAppMessages.Char, $code, [IntPtr]1)
    }
}

function Get-OrcaDesktopVirtualKey([string]$Key) {
    $map = @{
        "return" = 0x0D; "enter" = 0x0D; "tab" = 0x09; "escape" = 0x1B; "esc" = 0x1B; "backspace" = 0x08
        "forwarddelete" = 0x2E; "delete" = 0x2E; "space" = 0x20; "left" = 0x25; "up" = 0x26; "right" = 0x27
        "down" = 0x28; "home" = 0x24; "end" = 0x23; "pageup" = 0x21; "pagedown" = 0x22; "insert" = 0x2D
    }
    $normalized = $Key.ToLowerInvariant()
    if ($map.ContainsKey($normalized)) { return $map[$normalized] }
    if ($normalized -match '^f([1-9]|1[0-2])$') { return 0x6F + [int]$Matches[1] }
    if ($Key.Length -eq 1) {
        $virtualKey = [OrcaDesktopAppWin32]::VirtualKeyForChar($Key[0])
        if ($virtualKey -ge 0) { return $virtualKey }
    }
    throw "unsupported key: $Key"
}

function Send-OrcaDesktopKey($Target, [string]$KeySpec) {
    $parts = @($KeySpec.Split("+") | ForEach-Object { $_.Trim().ToLowerInvariant() } | Where-Object { $_ -ne "" })
    if ($parts.Count -eq 0) { throw "unsupported key: $KeySpec" }
    $key = $parts[$parts.Count - 1]
    $modifiers = @(if ($parts.Count -gt 1) { $parts[0..($parts.Count - 2)] })
    foreach ($modifier in $modifiers) {
        if ($modifier -notin @("cmd", "command", "ctrl", "control", "alt", "option", "shift")) { throw "unsupported modifier: $modifier" }
    }
    $hasControl = @($modifiers | Where-Object { $_ -in @("cmd", "command", "ctrl", "control") }).Count -gt 0
    $hasAlt = @($modifiers | Where-Object { $_ -in @("alt", "option") }).Count -gt 0
    $hasShift = $modifiers -contains "shift"
    # Why: posted messages leave the real keyboard state untouched, so a target reading
    # GetKeyState would never see a posted Ctrl. Ctrl+letter is delivered as the control
    # character edit controls already act on (Ctrl+A = 0x01, Ctrl+C = 0x03, ...).
    $controlCharacter = $hasControl -and -not $hasAlt -and -not $hasShift -and $key -match '^[a-z]$'
    if (-not $controlCharacter -and ($hasControl -or $hasShift)) {
        throw "unsupported capability: $KeySpec cannot be delivered to a background window on this platform"
    }
    $virtualKey = if ($controlCharacter) { 0 } else { Get-OrcaDesktopVirtualKey $key }
    $focus = [OrcaDesktopAppWin32]::KeyboardTarget($Target.handle)
    if ($controlCharacter) {
        [OrcaDesktopAppWin32]::Post($focus, $DesktopAppMessages.Char, ([int][char]$key - 0x60), [IntPtr]1)
        return
    }
    $extended = $DesktopAppExtendedKeys -contains $virtualKey
    $downMessage = if ($hasAlt) { $DesktopAppMessages.SysKeyDown } else { $DesktopAppMessages.KeyDown }
    $upMessage = if ($hasAlt) { $DesktopAppMessages.SysKeyUp } else { $DesktopAppMessages.KeyUp }
    [OrcaDesktopAppWin32]::Post($focus, $downMessage, $virtualKey, [OrcaDesktopAppWin32]::KeyLParam($virtualKey, $extended, $false, $hasAlt))
    [OrcaDesktopAppWin32]::Post($focus, $upMessage, $virtualKey, [OrcaDesktopAppWin32]::KeyLParam($virtualKey, $extended, $true, $hasAlt))
}

function Invoke-OrcaDesktopInput($Operation) {
    $payload = $Operation.input
    if ($null -eq $payload) { throw "invalid_argument: input is required" }
    $target = Resolve-OrcaDesktopTarget $Operation
    switch ([string]$payload.kind) {
        "click" { Send-OrcaDesktopClick $target $payload }
        "scroll" { Send-OrcaDesktopScroll $target $payload }
        "text" { Send-OrcaDesktopText $target ([string]$payload.text) }
        "key" { Send-OrcaDesktopKey $target (Get-OrcaRequiredString $payload.key "key") }
        default { throw "invalid_argument: unsupported input kind $($payload.kind)" }
    }
    # Why: posted messages are the only path that never activates the target, so every
    # delivery is synthetic; the macOS-only accessibility path has no background equivalent here.
    "synthetic"
}

# Desktop App operations work in physical pixels (the captured frame's space) and put the thread's
# DPI awareness back after, so later operations in this serve loop keep their coordinates.
function Invoke-OrcaInPhysicalPixels([scriptblock]$Action) {
    $previous = [OrcaDesktopAppWin32]::UsePhysicalPixels()
    try { & $Action } finally { [OrcaDesktopAppWin32]::RestoreDpiContext($previous) }
}

function Invoke-OrcaOperation($Operation) {
    $includeScreenshot = -not [bool]$Operation.noScreenshot
    if ($Operation.tool -eq "handshake") {
        return [pscustomobject]@{ ok = $true; capabilities = Get-OrcaHandshake }
    }
    if ($Operation.tool -eq "list_apps") {
        return [pscustomobject]@{ ok = $true; apps = @(Get-OrcaAppList) }
    }
    if ($Operation.tool -eq "list_windows") {
        $list = Get-OrcaWindowList $Operation.app
        return [pscustomobject]@{ ok = $true; app = $list.app; windows = @($list.windows) }
    }
    if ($Operation.tool -eq "list_desktop_windows") {
        return [pscustomobject]@{ ok = $true; desktopWindows = @(Invoke-OrcaInPhysicalPixels { Get-OrcaDesktopWindows $Operation.excludePid }) }
    }
    if ($Operation.tool -eq "desktop_input") {
        return [pscustomobject]@{ ok = $true; path = Invoke-OrcaInPhysicalPixels { Invoke-OrcaDesktopInput $Operation } }
    }
    if ($Operation.tool -eq "get_app_state") {
        return [pscustomobject]@{ ok = $true; snapshot = New-OrcaSnapshot $Operation.app $includeScreenshot $Operation.windowId $Operation.windowIndex ([bool]$Operation.restoreWindow) }
    }

    $process = Find-OrcaProcess $Operation.app
    if ([bool]$Operation.restoreWindow) { Restore-OrcaWindow $process }
    Assert-OrcaWindowTarget $process $Operation.windowId $Operation.windowIndex
    $root = Get-OrcaRootElement $process
    $windowFrame = if ($null -ne $Operation.windowBounds) { $Operation.windowBounds } else { Get-OrcaWindowFrame $process $root }
    $element = Find-OrcaElement $root $Operation.element
    $fromElement = Find-OrcaElement $root $Operation.fromElement
    $toElement = Find-OrcaElement $root $Operation.toElement
    $handle = [IntPtr]$process.MainWindowHandle
    if ($Operation.tool -in @("type_text", "press_key", "hotkey", "paste_text")) {
        Assert-OrcaKeyboardFocus $handle $Operation
    }
    $action = $null

    switch ($Operation.tool) {
        "click" {
            # Why: agents expect a click into a target app to make the next
            # keyboard action safe, even when UI Automation handles the click.
            Restore-OrcaWindow $process
            $handledByPattern = $false
            $clickCount = Get-OrcaPositiveInteger $Operation.click_count "click_count"
            $hasModifiers = -not [string]::IsNullOrWhiteSpace([string]$Operation.modifiers)
            if (-not $hasModifiers -and $null -ne $element -and $Operation.mouse_button -ne "right" -and $Operation.mouse_button -ne "middle" -and $clickCount -le 1) {
                $handledByPattern = Invoke-OrcaPrimaryAction $element
            }
            if (-not $handledByPattern) {
                $point = Get-OrcaElementScreenPoint $element
                if ($null -eq $point) { $point = Get-OrcaScreenPoint $Operation $windowFrame }
                Send-OrcaMouseClick $handle $point.x $point.y $Operation.mouse_button $clickCount $Operation.modifiers
                $action = [pscustomobject]@{ path = "synthetic"; actionName = $null; fallbackReason = "actionUnsupported" }
            } else {
                $action = [pscustomobject]@{ path = "accessibility"; actionName = "primaryAction"; fallbackReason = $null }
            }
        }
        "perform_secondary_action" {
            if ($null -eq $element) { throw "unknown element_index" }
            if (-not (Invoke-OrcaNamedAction $element $Operation.action)) {
                throw "$($Operation.action) is not a valid secondary action"
            }
            $action = [pscustomobject]@{ path = "accessibility"; actionName = $Operation.action; fallbackReason = $null }
        }
        "scroll" {
            $delta = 120 * [int][Math]::Ceiling((Get-OrcaPositiveNumber $Operation.pages "pages"))
            $mouseEvent = $MouseEvents.Wheel
            if ($Operation.direction -eq "down") {
                $delta = -1 * $delta
            } elseif ($Operation.direction -eq "left") {
                $mouseEvent = $MouseEvents.HorizontalWheel
                $delta = -1 * $delta
            } elseif ($Operation.direction -eq "right") {
                $mouseEvent = $MouseEvents.HorizontalWheel
            } elseif ($Operation.direction -ne "up") {
                throw "unsupported scroll direction: $($Operation.direction)"
            }
            $point = Get-OrcaElementScreenPoint $element
            if ($null -eq $point) { $point = Get-OrcaScreenPoint $Operation $windowFrame }
            [void][OrcaDesktopWin32]::SetForegroundWindow($handle)
            [void][OrcaDesktopWin32]::SetCursorPos([int]$point.x, [int]$point.y)
            [OrcaDesktopWin32]::mouse_event($mouseEvent, 0, 0, $delta, [UIntPtr]::Zero)
            $action = [pscustomobject]@{ path = "synthetic"; actionName = "scroll"; fallbackReason = $null }
        }
        "drag" {
            $from = Get-OrcaElementScreenPoint $fromElement
            if ($null -eq $from -and $null -ne $Operation.fromElement) { throw "stale element frame; run get-app-state again and use a fresh element index" }
            if ($null -eq $from) {
                $from = @{
                    x = $windowFrame.x + (Get-OrcaRequiredNumber $Operation.from_x "from_x")
                    y = $windowFrame.y + (Get-OrcaRequiredNumber $Operation.from_y "from_y")
                }
            }
            $to = Get-OrcaElementScreenPoint $toElement
            if ($null -eq $to -and $null -ne $Operation.toElement) { throw "stale element frame; run get-app-state again and use a fresh element index" }
            if ($null -eq $to) {
                $to = @{
                    x = $windowFrame.x + (Get-OrcaRequiredNumber $Operation.to_x "to_x")
                    y = $windowFrame.y + (Get-OrcaRequiredNumber $Operation.to_y "to_y")
                }
            }
            Send-OrcaDrag $handle $from $to
            $action = [pscustomobject]@{ path = "synthetic"; actionName = "drag"; fallbackReason = $null }
        }
        "type_text" {
            Send-OrcaText $handle (Get-OrcaRequiredString $Operation.text "text")
            $action = [pscustomobject]@{ path = "synthetic"; actionName = "typeText"; fallbackReason = $null; verification = [pscustomobject]@{ state = "unverified"; reason = "synthetic_input" } }
        }
        "press_key" {
            Send-OrcaKey $handle (Get-OrcaRequiredString $Operation.key "key")
            $action = [pscustomobject]@{ path = "synthetic"; actionName = "pressKey"; fallbackReason = $null; verification = [pscustomobject]@{ state = "unverified"; reason = "synthetic_input" } }
        }
        "hotkey" {
            Send-OrcaHotkey $handle (Get-OrcaRequiredString $Operation.key "key")
            $action = [pscustomobject]@{ path = "synthetic"; actionName = "hotkey"; fallbackReason = $null; verification = [pscustomobject]@{ state = "unverified"; reason = "synthetic_input" } }
        }
        "paste_text" {
            Send-OrcaPasteText $handle (Get-OrcaRequiredString $Operation.text "text")
            $action = [pscustomobject]@{ path = "clipboard"; actionName = "paste"; fallbackReason = $null; verification = [pscustomobject]@{ state = "unverified"; reason = "clipboard_paste" } }
        }
        "set_value" {
            if ($null -eq $element -or -not (Set-OrcaElementValue $element ([string]$Operation.value))) {
                throw "element value is not settable"
            }
            $action = [pscustomobject]@{ path = "accessibility"; actionName = "setValue"; fallbackReason = $null }
        }
        default {
            throw "unsupported tool: $($Operation.tool)"
        }
    }

    try {
        $snapshot = New-OrcaSnapshot $Operation.app $includeScreenshot $Operation.windowId $Operation.windowIndex
    } catch {
        if ($null -eq $Operation.windowId -and $null -eq $Operation.windowIndex) { throw }
        if ($null -eq $action.verification) {
            $action | Add-Member -NotePropertyName verification -NotePropertyValue ([pscustomobject]@{ state = "unverified"; reason = "window_changed" })
        }
        $snapshot = New-OrcaSnapshot $Operation.app $includeScreenshot $null $null
    }
    [pscustomobject]@{ ok = $true; action = $action; snapshot = $snapshot }
}

function Invoke-OrcaServeLoop {
    # Announce readiness after Add-Type and before reading: absence proves no request ran and permits safe replay.
    # A missing response cannot prove that; replay could duplicate input.
    [Console]::Out.WriteLine('{"ready":true}')
    [Console]::Out.Flush()
    # NDJSON request/response lines may exceed 1 MiB with screenshots; console line IO is memory-bounded.
    while ($true) {
        $line = [Console]::In.ReadLine()
        if ($null -eq $line) { break }
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        $requestId = $null
        try {
            $operation = $line | ConvertFrom-Json
            $requestId = $operation.requestId
            $response = Invoke-OrcaOperation $operation
        } catch {
            $response = [pscustomobject]@{ ok = $false; error = [string]$_.Exception.Message }
            # ConvertFrom-Json can fail before reading id; recover it from raw input so the error reaches its request
            # instead of tripping desync cleanup/cooldown and hiding the parse failure.
            if ($null -eq $requestId -and $line -match '"requestId"\s*:\s*(\d+)') {
                $requestId = [long]$Matches[1]
            }
        }
        # Echo id to bind the response; unmatched replies indicate stream desynchronization.
        if ($null -ne $requestId) {
            $response | Add-Member -NotePropertyName requestId -NotePropertyValue $requestId -Force
        }
        [Console]::Out.WriteLine((ConvertTo-Json $response -Depth 100 -Compress))
        [Console]::Out.Flush()
    }
}

if ($Serve) {
    Invoke-OrcaServeLoop
} elseif ([string]::IsNullOrWhiteSpace($OperationPath)) {
    Write-OrcaJson ([pscustomobject]@{ ok = $false; error = "runtime.ps1 requires an operation path or -Serve" })
} else {
    try {
        $operation = Read-OrcaOperation $OperationPath
        Write-OrcaJson (Invoke-OrcaOperation $operation)
    } catch {
        Write-OrcaJson ([pscustomobject]@{ ok = $false; error = [string]$_.Exception.Message })
    }
}
