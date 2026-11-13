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

Add-Type -ReferencedAssemblies @(
    'System.dll',
    [System.Drawing.Bitmap].Assembly.Location,
    [Windows.Automation.AutomationElement].Assembly.Location,
    [Windows.Automation.AutomationIdentifier].Assembly.Location
) -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class OrcaDesktopWin32 {
    // Default proxy discovery needs a typed caller before PowerShell's dynamic stack frames.
    [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
    public static void InitializeAutomation() {
        System.Windows.Automation.ClientSettings.RegisterClientSideProviders(
            new System.Windows.Automation.ClientSideProviderDescription[0]);
    }

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

    [DllImport("user32.dll", EntryPoint = "PostMessageW")]
    public static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hwnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hwnd);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hwnd);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);

    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int x, int y);

    [DllImport("user32.dll")]
    public static extern bool GetCursorPos(out POINT point);

    [DllImport("dwmapi.dll")]
    private static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out int value, int size);

    [DllImport("user32.dll")]
    private static extern int GetSystemMetrics(int index);

    // DWMWA_CLOAKED: the shell hides windows on other virtual desktops this way; raising one switches desktops.
    public static bool IsWindowCloaked(IntPtr hwnd) {
        int cloaked;
        return DwmGetWindowAttribute(hwnd, 14, out cloaked, sizeof(int)) == 0 && cloaked != 0;
    }

    // Queued behind input already sent, so a click or wheel lands before the pointer moves; SetCursorPos would race it.
    public static void MoveCursorAfterInput(int x, int y) {
        long left = GetSystemMetrics(76);
        long top = GetSystemMetrics(77);
        long width = Math.Max(1, GetSystemMetrics(78));
        long height = Math.Max(1, GetSystemMetrics(79));
        // Absolute coordinates are 0..65535 across the virtual desktop; aim at the pixel's center.
        var dx = (uint)(((x - left) * 65536 + 32768) / width);
        var dy = (uint)(((y - top) * 65536 + 32768) / height);
        const uint move = 0x0001, virtualDesk = 0x4000, absolute = 0x8000;
        mouse_event(move | virtualDesk | absolute, dx, dy, 0, UIntPtr.Zero);
    }

    [DllImport("user32.dll")]
    public static extern void mouse_event(uint dwFlags, uint dx, uint dy, int dwData, UIntPtr dwExtraInfo);

    [DllImport("user32.dll")]
    public static extern uint SendInput(uint count, INPUT[] inputs, int size);

    [DllImport("user32.dll")]
    private static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);

    [DllImport("user32.dll")]
    private static extern bool GetClientRect(IntPtr hwnd, out RECT rect);

    [DllImport("user32.dll")]
    private static extern bool ClientToScreen(IntPtr hwnd, ref POINT point);

    [DllImport("user32.dll")]
    private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);

    [DllImport("user32.dll", EntryPoint = "SendMessageTimeoutW", SetLastError = true)]
    private static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);

    [DllImport("user32.dll")]
    private static extern bool IsHungAppWindow(IntPtr hwnd);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inheritHandle, int processId);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool GetTokenInformation(IntPtr token, int informationClass, IntPtr information, int length, out int returnLength);

    [DllImport("advapi32.dll")]
    private static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);

    [DllImport("advapi32.dll")]
    private static extern IntPtr GetSidSubAuthority(IntPtr sid, uint index);

    // WM_NULL round trip; SMTO_ABORTIFHUNG returns at once for a window Windows already marks hung.
    public static bool IsWindowHung(IntPtr hwnd, uint timeoutMilliseconds) {
        IntPtr result;
        if (SendMessageTimeout(hwnd, 0, IntPtr.Zero, IntPtr.Zero, 0x0002, timeoutMilliseconds, out result) != IntPtr.Zero) {
            return false;
        }
        const int errorTimeout = 1460;
        // Other failures (a closed window, UIPI refusing an elevated target) are not hangs.
        return Marshal.GetLastWin32Error() == errorTimeout || IsHungAppWindow(hwnd);
    }

    // Mandatory integrity RID (0x2000 medium, 0x3000 high), or -1 when the process cannot be queried.
    public static int GetProcessIntegrityLevel(int processId) {
        const uint processQueryLimitedInformation = 0x1000;
        const uint tokenQuery = 0x0008;
        const int tokenIntegrityLevel = 25;
        var process = OpenProcess(processQueryLimitedInformation, false, processId);
        if (process == IntPtr.Zero) { return -1; }
        var token = IntPtr.Zero;
        var buffer = IntPtr.Zero;
        try {
            if (!OpenProcessToken(process, tokenQuery, out token)) { return -1; }
            int length;
            GetTokenInformation(token, tokenIntegrityLevel, IntPtr.Zero, 0, out length);
            if (length <= 0) { return -1; }
            buffer = Marshal.AllocHGlobal(length);
            if (!GetTokenInformation(token, tokenIntegrityLevel, buffer, length, out length)) { return -1; }
            var sid = Marshal.ReadIntPtr(buffer);
            int count = Marshal.ReadByte(GetSidSubAuthorityCount(sid));
            if (count <= 0) { return -1; }
            return Marshal.ReadInt32(GetSidSubAuthority(sid, (uint)(count - 1)));
        } finally {
            if (buffer != IntPtr.Zero) { Marshal.FreeHGlobal(buffer); }
            if (token != IntPtr.Zero) { CloseHandle(token); }
            CloseHandle(process);
        }
    }

    private sealed class WindowCapture {
        private readonly object gate = new object();
        private readonly IntPtr hwnd;
        private readonly int width;
        private readonly int height;
        private bool abandoned;
        private System.Drawing.Bitmap result;

        public WindowCapture(IntPtr hwnd, int width, int height) {
            this.hwnd = hwnd;
            this.width = width;
            this.height = height;
        }

        public void Run() {
            System.Drawing.Bitmap bitmap = null;
            try { bitmap = RenderWindow(hwnd, width, height); } catch {}
            lock (gate) {
                if (abandoned) {
                    if (bitmap != null) { bitmap.Dispose(); }
                } else {
                    result = bitmap;
                }
            }
        }

        public System.Drawing.Bitmap Take() {
            lock (gate) {
                abandoned = true;
                return result;
            }
        }
    }

    // Renders the window itself, so covering windows are not captured; null when the render is unusable or too slow.
    public static System.Drawing.Bitmap CaptureWindow(IntPtr hwnd, int width, int height, int timeoutMilliseconds) {
        var capture = new WindowCapture(hwnd, width, height);
        var thread = new System.Threading.Thread(capture.Run);
        thread.IsBackground = true;
        thread.Start();
        // Why: PrintWindow waits on the target's WM_PRINT with no timeout; a stuck render must not stall the serve loop.
        thread.Join(timeoutMilliseconds);
        return capture.Take();
    }

    private static System.Drawing.Bitmap RenderWindow(IntPtr hwnd, int width, int height) {
        var previousDpiContext = IntPtr.Zero;
        try {
            // Per-monitor-aware V2: a DPI-unaware caller would get a scaled rect but a full-size render.
            previousDpiContext = SetThreadDpiAwarenessContext(new IntPtr(-4));
        } catch (EntryPointNotFoundException) {}
        System.Drawing.Bitmap rendered = null;
        try {
            RECT rect;
            if (!GetWindowRect(hwnd, out rect)) { return null; }
            var renderedWidth = rect.Right - rect.Left;
            var renderedHeight = rect.Bottom - rect.Top;
            if (renderedWidth <= 0 || renderedHeight <= 0) { return null; }
            rendered = new System.Drawing.Bitmap(renderedWidth, renderedHeight, System.Drawing.Imaging.PixelFormat.Format32bppRgb);
            var printed = false;
            using (var graphics = System.Drawing.Graphics.FromImage(rendered)) {
                var hdc = graphics.GetHdc();
                try {
                    // PW_RENDERFULLCONTENT includes DirectComposition content (Chromium, Electron, WinUI).
                    printed = PrintWindow(hwnd, hdc, 2);
                } finally {
                    graphics.ReleaseHdc(hdc);
                }
            }
            if (!printed) { return null; }
            var whole = new System.Drawing.Rectangle(0, 0, renderedWidth, renderedHeight);
            if (UniformColor(rendered, whole) >= 0) { return null; }
            // A black client area inside a drawn frame means the content itself did not render.
            var client = GetClientRegion(hwnd, rect, renderedWidth, renderedHeight);
            if (client.Width > 0 && client.Height > 0 && UniformColor(rendered, client) == 0) { return null; }
            if (renderedWidth == width && renderedHeight == height) {
                var result = rendered;
                rendered = null;
                return result;
            }
            // Keep screenshot pixels in the same window coordinate space as element frames and clicks.
            var scaled = new System.Drawing.Bitmap(width, height, System.Drawing.Imaging.PixelFormat.Format32bppRgb);
            using (var graphics = System.Drawing.Graphics.FromImage(scaled)) {
                graphics.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBilinear;
                graphics.DrawImage(rendered, 0, 0, width, height);
            }
            return scaled;
        } finally {
            if (rendered != null) { rendered.Dispose(); }
            if (previousDpiContext != IntPtr.Zero) { SetThreadDpiAwarenessContext(previousDpiContext); }
        }
    }

    // Uniform 24-bit color of the region, or -1 when it holds more than one color.
    private static int UniformColor(System.Drawing.Bitmap bitmap, System.Drawing.Rectangle region) {
        var data = bitmap.LockBits(region, System.Drawing.Imaging.ImageLockMode.ReadOnly, System.Drawing.Imaging.PixelFormat.Format32bppRgb);
        try {
            var row = new int[region.Width];
            var first = Marshal.ReadInt32(data.Scan0) & 0xFFFFFF;
            for (var y = 0; y < region.Height; y++) {
                Marshal.Copy(IntPtr.Add(data.Scan0, y * data.Stride), row, 0, row.Length);
                foreach (var pixel in row) {
                    if ((pixel & 0xFFFFFF) != first) { return -1; }
                }
            }
            return first;
        } finally {
            bitmap.UnlockBits(data);
        }
    }

    // Client area in window-bitmap coordinates, clipped to the bitmap; empty when unknown.
    private static System.Drawing.Rectangle GetClientRegion(IntPtr hwnd, RECT window, int width, int height) {
        RECT client;
        var origin = new POINT();
        if (!GetClientRect(hwnd, out client) || !ClientToScreen(hwnd, ref origin)) { return System.Drawing.Rectangle.Empty; }
        var region = new System.Drawing.Rectangle(origin.X - window.Left, origin.Y - window.Top, client.Right - client.Left, client.Bottom - client.Top);
        region.Intersect(new System.Drawing.Rectangle(0, 0, width, height));
        return region;
    }

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

[OrcaDesktopWin32]::InitializeAutomation()

$MaxNodes = 1200
$MaxDepth = 64
$TextLimit = 500
$MaxScreenshotPngBytes = 900000
$MaxScreenshotEdge = 1280
$MinScreenshotScale = 0.25
$ScreenshotScaleStep = 0.85
# Windows' own hung-window threshold, so a briefly busy app is not reported as hung; still far under the request timeout.
$WindowResponseTimeoutMilliseconds = 5000
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
    if ([OrcaDesktopWin32]::IsWindowHung([IntPtr]$Process.MainWindowHandle, $WindowResponseTimeoutMilliseconds)) {
        throw "window_not_responding: $(Get-OrcaAppName $Process) is not responding; nothing was read from or sent to it"
    }
    [Windows.Automation.AutomationElement]::FromHandle([IntPtr]$Process.MainWindowHandle)
}

function Assert-OrcaInputAllowed($Process) {
    $targetLevel = [OrcaDesktopWin32]::GetProcessIntegrityLevel([int]$Process.Id)
    $ownLevel = [OrcaDesktopWin32]::GetProcessIntegrityLevel($PID)
    # Why: UIPI silently drops input to a higher-integrity process; unknown levels proceed as before.
    if ($targetLevel -lt 0 -or $ownLevel -lt 0 -or $targetLevel -le $ownLevel) { return }
    throw "target_elevated: $(Get-OrcaAppName $Process) runs as administrator, so Windows blocks input to it from Orca; no input was sent"
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

function Invoke-OrcaWindowPatternActivation($RootElement) {
    # Why: reapplying the current visual state lets the window's provider activate it when Windows refuses our raise (agent-desktop #651).
    try {
        $pattern = $RootElement.GetCurrentPattern([Windows.Automation.WindowPattern]::Pattern)
        $state = $pattern.Current.WindowVisualState
        if ($state -ne [Windows.Automation.WindowVisualState]::Minimized) { $pattern.SetWindowVisualState($state) }
    } catch {}
}

# Brings only the target window to the front; returns $null once it is the foreground window, otherwise why not.
function Restore-OrcaWindow($Process, $RootElement) {
    $handle = [IntPtr]$Process.MainWindowHandle
    if ($handle -eq [IntPtr]::Zero) { return "it has no top-level window" }
    if ([OrcaDesktopWin32]::IsWindowCloaked($handle)) {
        return "it is on another virtual desktop, and raising it would switch the user's desktop"
    }
    # Why: SW_RESTORE also un-maximizes, which moves the frame the agent targeted.
    if ([OrcaDesktopWin32]::IsIconic($handle)) {
        [void][OrcaDesktopWin32]::ShowWindow($handle, 9)
    }
    if (Test-OrcaWindowFocused $handle) { return $null }
    # Why: Windows often refuses a background process's raise; after one refusal try the UIA route, then one more raise.
    [void][OrcaDesktopWin32]::SetForegroundWindow($handle)
    if (Wait-OrcaWindowFocused $handle 250) { return $null }
    Invoke-OrcaWindowPatternActivation $RootElement
    if (Wait-OrcaWindowFocused $handle 250) { return $null }
    [void][OrcaDesktopWin32]::SetForegroundWindow($handle)
    if (Wait-OrcaWindowFocused $handle 250) { return $null }
    "Windows refused to bring it to the front"
}

function Test-OrcaTargetTookForeground([IntPtr]$Before, $Process) {
    $after = [OrcaDesktopWin32]::GetForegroundWindow()
    if ($after -eq $Before) { return $false }
    $owner = [uint32]0
    [void][OrcaDesktopWin32]::GetWindowThreadProcessId($after, [ref]$owner)
    $owner -eq $Process.Id
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

function Assert-OrcaKeyboardFocus([IntPtr]$WindowHandle, $Operation, $RestoreFailure = $null) {
    if (Test-OrcaWindowFocused $WindowHandle) { return }
    if ([bool]$Operation.restoreWindow) {
        $reason = if ($null -ne $RestoreFailure) { " ($RestoreFailure)" } else { "" }
        throw "window_not_focused: keyboard input requires the target window to be focused; restoreWindow was requested but the target window is still not focused$reason; bring it forward manually or check desktop permissions"
    }
    throw "window_not_focused: keyboard input requires the target window to be focused; retry with --restore-window"
}

# Raises the target for real mouse input, then returns its frame read after the raise (restoring moves it).
function Restore-OrcaPointerWindow($Process, $RootElement) {
    $failure = Restore-OrcaWindow $Process $RootElement
    if ($null -ne $failure) {
        throw "window_not_focused: restoreWindow was requested but $(Get-OrcaAppName $Process) did not come to the front ($failure); no pointer input was sent"
    }
    Get-OrcaWindowFrame $Process $RootElement
}

function New-OrcaForegroundRefusal($Process, [string]$Need, [string]$Alternative = "") {
    $hint = if ([string]::IsNullOrEmpty($Alternative)) { "" } else { " $Alternative" }
    "background_unavailable: $Need, which on Windows brings $(Get-OrcaAppName $Process) to the front and moves the user's pointer; nothing was sent.$hint Ask the user before retrying with --restore-window."
}

function Get-OrcaCursorPosition {
    $point = New-Object OrcaDesktopWin32+POINT
    if ([OrcaDesktopWin32]::GetCursorPos([ref]$point)) { return $point }
    $null
}

function Restore-OrcaCursorPosition($Point) {
    if ($null -ne $Point) { [OrcaDesktopWin32]::MoveCursorAfterInput($Point.X, $Point.Y) }
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

function Get-OrcaRangeValueText($Element) {
    try {
        $pattern = $Element.GetCurrentPattern([Windows.Automation.RangeValuePattern]::Pattern)
        ([double]$pattern.Current.Value).ToString([Globalization.CultureInfo]::InvariantCulture)
    } catch {
        ""
    }
}

function Test-OrcaRangeValueWritable($Element) {
    try {
        -not $Element.GetCurrentPattern([Windows.Automation.RangeValuePattern]::Pattern).Current.IsReadOnly
    } catch {
        $false
    }
}

function Get-OrcaExpandCollapseActions($Element) {
    try {
        $state = $Element.GetCurrentPattern([Windows.Automation.ExpandCollapsePattern]::Pattern).Current.ExpandCollapseState
    } catch {
        return @()
    }
    switch ($state) {
        ([Windows.Automation.ExpandCollapseState]::Collapsed) { return @("Expand") }
        ([Windows.Automation.ExpandCollapseState]::Expanded) { return @("Collapse") }
        ([Windows.Automation.ExpandCollapseState]::PartiallyExpanded) { return @("Expand", "Collapse") }
    }
    @()
}

function Get-OrcaActions($Element, $Patterns = $null) {
    if ($null -eq $Patterns) { $Patterns = @($Element.GetSupportedPatterns()) }
    $actions = New-Object System.Collections.Generic.List[string]
    foreach ($pattern in $Patterns) {
        $name = [string]$pattern.ProgrammaticName
        if ($name -like "InvokePatternIdentifiers.Pattern") { $actions.Add("Invoke") }
        elseif ($name -like "TogglePatternIdentifiers.Pattern") { $actions.Add("Toggle") }
        elseif ($name -like "SelectionItemPatternIdentifiers.Pattern") { $actions.Add("Select") }
        elseif ($name -like "ScrollPatternIdentifiers.Pattern") { $actions.Add("Scroll") }
        elseif ($name -like "ValuePatternIdentifiers.Pattern") { $actions.Add("SetValue") }
        elseif ($name -like "RangeValuePatternIdentifiers.Pattern") { if (Test-OrcaRangeValueWritable $Element) { $actions.Add("SetValue") } }
        elseif ($name -like "ExpandCollapsePatternIdentifiers.Pattern") { foreach ($action in @(Get-OrcaExpandCollapseActions $Element)) { $actions.Add($action) } }
        elseif ($name -like "ScrollItemPatternIdentifiers.Pattern") { $actions.Add("ScrollToVisible") }
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
    $patterns = @($Element.GetSupportedPatterns())
    $value = Get-OrcaValueText $Element
    if ([string]::IsNullOrEmpty($value) -and $patterns -contains [Windows.Automation.RangeValuePattern]::Pattern) {
        $value = Get-OrcaRangeValueText $Element
    }
    [pscustomobject]@{
        index = $Index
        runtimeId = @(Get-OrcaRuntimeId $Element)
        automationId = Get-OrcaProperty $Element "AutomationId"
        name = Get-OrcaProperty $Element "Name"
        controlType = $controlType
        localizedControlType = Get-OrcaProperty $Element "LocalizedControlType"
        className = Get-OrcaProperty $Element "ClassName"
        value = $value
        isSelected = Test-OrcaElementSelected $Element
        isDisabled = Test-OrcaElementDisabled $Element
        nativeWindowHandle = $nativeWindowHandle
        frame = Get-OrcaElementFrame $Element $WindowFrame
        actions = @(Get-OrcaActions $Element $patterns)
    }
}

function Test-OrcaElementDisabled($Element) {
    try { return -not [bool]$Element.Current.IsEnabled } catch { return $false }
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
    # Tab compaction shrinks records mid-walk, so $records.Count would reuse retained indexes.
    $nextIndex = [ref]0

    function Visit-OrcaChildren($Children, [int]$Depth) {
        for ($i = 0; $i -lt $Children.Count; $i++) {
            if ($records.Count -ge $MaxNodes -or $Depth -gt $MaxDepth) {
                $truncation.truncated = $true
                if ($Depth -gt $MaxDepth) { $truncation.maxDepthReached = $true }
                # Marks where the walk stopped, so the agent can read that parent's subtree by index.
                $lines.Add(("`t" * $Depth) + "... $($Children.Count - $i) more not shown (snapshot limit)")
                return
            }
            Visit-OrcaNode $Children.Item($i) $Depth
        }
    }

    function Visit-OrcaNode($Node, [int]$Depth) {
        $identity = try { (@($Node.GetRuntimeId()) -join ".") } catch { [Guid]::NewGuid().ToString() }
        if (-not $seen.Add($identity)) { return }

        $record = New-OrcaElementRecord $Node $nextIndex.Value $WindowFrame
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
            Visit-OrcaChildren $children $Depth
            return
        }

        $records.Add($record)
        $nextIndex.Value++

        $traits = if ($record.isDisabled) { " (disabled)" } else { "" }
        $line = "$($record.index) $role$traits $(Format-OrcaSnapshotText $title)".TrimEnd()
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
        Visit-OrcaChildren $children ($Depth + 1)
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

function Get-OrcaScreenshot([bool]$IncludeScreenshot, $WindowFrame, [IntPtr]$WindowHandle) {
    if (-not $IncludeScreenshot -or $null -eq $WindowFrame) { return $null }
    $bitmap = $null
    $graphics = $null
    try {
        $width = [int][Math]::Max(1, [Math]::Round($WindowFrame.width))
        $height = [int][Math]::Max(1, [Math]::Round($WindowFrame.height))
        $bitmap = [OrcaDesktopWin32]::CaptureWindow($WindowHandle, $width, $height, $WindowResponseTimeoutMilliseconds)
        if ($null -eq $bitmap) {
            # Screen copy shows whatever is on top, so it is only the fallback for windows that render blank.
            $bitmap = New-Object System.Drawing.Bitmap $width, $height
            $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
            $graphics.CopyFromScreen([int][Math]::Round($WindowFrame.x), [int][Math]::Round($WindowFrame.y), 0, 0, $bitmap.Size)
        }
        Get-OrcaBoundedScreenshotPayload $bitmap
    } catch {
        $null
    } finally {
        if ($null -ne $graphics) { $graphics.Dispose() }
        if ($null -ne $bitmap) { $bitmap.Dispose() }
    }
}

function New-OrcaSnapshot([string]$Query, [bool]$IncludeScreenshot, $WindowId = $null, $WindowIndex = $null, [bool]$RestoreWindow = $false, $TreeRoot = $null) {
    $process = Find-OrcaProcess $Query
    Assert-OrcaWindowTarget $process $WindowId $WindowIndex
    # Root first: its hang probe must run before ShowWindow, which blocks on a hung window.
    $root = Get-OrcaRootElement $process
    # Why: observation works behind other windows, so a refused raise still returns the snapshot.
    if ($RestoreWindow) { [void](Restore-OrcaWindow $process $root) }
    $windowFrame = Get-OrcaWindowFrame $process $root
    $walkRoot = $root
    if ($null -ne $TreeRoot) {
        $walkRoot = Find-OrcaElement $root $TreeRoot
        if ($null -eq $walkRoot) {
            throw "stale element: element $($TreeRoot.index) is gone; run get-app-state again and use a fresh element index"
        }
    }
    $tree = Render-OrcaTree $walkRoot $windowFrame (Test-OrcaBrowserProcess $process)
    $screenshot = Get-OrcaScreenshot $IncludeScreenshot $windowFrame ([IntPtr]$process.MainWindowHandle)

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
            observation = [pscustomobject]@{ screenshot = $true; annotatedScreenshot = $false; elementFrames = $true; ocr = $false; disabledState = $true }
            actions = [pscustomobject]@{
                click = $true
                typeText = $true
                typeTextElement = $false
                pressKey = $true
                hotkey = $true
                pasteText = $true
                scroll = $true
                drag = $true
                setValue = $true
                performAction = $true
            }
            surfaces = [pscustomobject]@{ menus = $false; dialogs = $false; dock = $false; menubar = $false }
            # Why: only UI Automation actions reach a background window; real mouse and key input is refused without restoreWindow.
            input = [pscustomobject]@{ background = $false }
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

# False only when the element offers none of these patterns; a pattern that fails is an error, never a cue for a real click.
function Invoke-OrcaPrimaryAction($Element, $Index) {
    foreach ($pattern in @(
        [Windows.Automation.InvokePattern]::Pattern,
        [Windows.Automation.SelectionItemPattern]::Pattern,
        [Windows.Automation.TogglePattern]::Pattern
    )) {
        $instance = $null
        if (-not $Element.TryGetCurrentPattern($pattern, [ref]$instance)) { continue }
        $name = ([string]$pattern.ProgrammaticName) -replace "PatternIdentifiers\.Pattern$", ""
        try {
            if ($pattern -eq [Windows.Automation.InvokePattern]::Pattern) { $instance.Invoke() }
            elseif ($pattern -eq [Windows.Automation.SelectionItemPattern]::Pattern) { $instance.Select() }
            else { $instance.Toggle() }
            return $true
        } catch {
            # Why: PowerShell wraps exceptions from method calls, so match the provider's own exception.
            $failure = $_.Exception.GetBaseException()
            if ($failure -is [Windows.Automation.ElementNotEnabledException]) {
                throw "element_not_enabled: element $Index is disabled, so no input was sent; do what enables it first, then run get-app-state and retry once its line no longer lists disabled"
            }
            throw "UI Automation $name failed on element ${Index}: $($failure.Message); no mouse click was sent in its place. Run get-app-state to check whether it took effect before retrying"
        }
    }
    $false
}

function Invoke-OrcaNamedAction($Element, [string]$Action) {
    $wanted = ""
    # Why: accept the rendered name ("ScrollToVisible") and macOS's spaced form ("scroll to visible").
    if ($null -ne $Action) { $wanted = ($Action -replace "\s+", "").ToLowerInvariant() }
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
        "expand" {
            $pattern = $Element.GetCurrentPattern([Windows.Automation.ExpandCollapsePattern]::Pattern)
            $pattern.Expand()
            return $true
        }
        "collapse" {
            $pattern = $Element.GetCurrentPattern([Windows.Automation.ExpandCollapsePattern]::Pattern)
            $pattern.Collapse()
            return $true
        }
        "scrolltovisible" {
            $pattern = $Element.GetCurrentPattern([Windows.Automation.ScrollItemPattern]::Pattern)
            $pattern.ScrollIntoView()
            return $true
        }
        default {
            return $false
        }
    }
}

function Test-OrcaRangeValueMatches([string]$Actual, [double]$Expected) {
    # Why: allow float32 rounding (0.1 reads back 0.100000001), but cap it so a snapped neighbour never verifies at any size.
    $actualNumber = 0.0
    [double]::TryParse($Actual, [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$actualNumber) -and
        [Math]::Abs($actualNumber - $Expected) -le [Math]::Min(1e-6 * [Math]::Max(1.0, [Math]::Abs($Expected)), 1e-3)
}

function Set-OrcaElementValue($Element, [string]$Value) {
    try {
        $pattern = $Element.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern)
        if (-not $pattern.Current.IsReadOnly) {
            $pattern.SetValue($Value)
            return [pscustomobject]@{ verification = $null }
        }
    } catch {}
    if (-not (Test-OrcaRangeValueWritable $Element)) { return $null }
    $range = $Element.GetCurrentPattern([Windows.Automation.RangeValuePattern]::Pattern)
    $culture = [Globalization.CultureInfo]::InvariantCulture
    $number = 0.0
    if (-not [double]::TryParse($Value, [Globalization.NumberStyles]::Float, $culture, [ref]$number) -or [double]::IsNaN($number)) {
        throw "value must be a number for this range control"
    }
    $minimum = [double]$range.Current.Minimum
    $maximum = [double]$range.Current.Maximum
    if ($number -lt $minimum -or $number -gt $maximum) {
        throw "value $Value is outside this range control's $($minimum.ToString($culture))..$($maximum.ToString($culture))"
    }
    $range.SetValue($number)
    # Why: Chromium applies the write asynchronously, so poll briefly like macOS's settled readback.
    $stopwatch = [Diagnostics.Stopwatch]::StartNew()
    while ($true) {
        $actual = Get-OrcaRangeValueText $Element
        $matched = Test-OrcaRangeValueMatches $actual $number
        if ($matched -or $stopwatch.ElapsedMilliseconds -ge 500) { break }
        Start-Sleep -Milliseconds 25
    }
    $verification = if ($matched) {
        [pscustomobject]@{ state = "verified"; property = "value"; expected = $Value; actualPreview = $actual }
    } elseif ([string]::IsNullOrEmpty($actual)) {
        # Why: a failed read is not evidence the write failed; only a read-back number can contradict it.
        [pscustomobject]@{ state = "unverified"; reason = "readback_unsupported"; expected = $Value }
    } else {
        [pscustomobject]@{ state = "unverified"; reason = "value_mismatch"; expected = $Value; actualPreview = $actual }
    }
    [pscustomobject]@{ verification = $verification }
}

function Get-OrcaScrollPattern($Element, $RootElement, [bool]$Vertical) {
    $rootId = Get-OrcaRuntimeId $RootElement
    $current = $Element
    # Why: an item's ScrollPattern lives on its list or viewport, the same container a wheel at its center would scroll.
    while ($null -ne $current) {
        try {
            $pattern = $current.GetCurrentPattern([Windows.Automation.ScrollPattern]::Pattern)
            $scrollable = if ($Vertical) { $pattern.Current.VerticallyScrollable } else { $pattern.Current.HorizontallyScrollable }
            if ($scrollable) { return $pattern }
        } catch {}
        if (Test-OrcaSameRuntimeId (Get-OrcaRuntimeId $current) $rootId) { break }
        $current = try { [Windows.Automation.TreeWalker]::RawViewWalker.GetParent($current) } catch { $null }
    }
    $null
}

# Innermost element under a screen point whose ScrollPattern scrolls that way; windows covering the point don't matter.
function Find-OrcaScrollContainerAt($RootElement, [double]$ScreenX, [double]$ScreenY, [bool]$Vertical) {
    $candidates = @($RootElement)
    try {
        $condition = New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::IsScrollPatternAvailableProperty, $true)
        $found = $RootElement.FindAll([Windows.Automation.TreeScope]::Descendants, $condition)
        for ($i = 0; $i -lt $found.Count; $i++) { $candidates += $found.Item($i) }
    } catch {}
    $best = $null
    $bestArea = [double]::PositiveInfinity
    foreach ($candidate in $candidates) {
        try {
            $rect = $candidate.Current.BoundingRectangle
            if ($rect.IsEmpty -or $ScreenX -lt $rect.X -or $ScreenY -lt $rect.Y -or $ScreenX -ge $rect.X + $rect.Width -or $ScreenY -ge $rect.Y + $rect.Height) { continue }
            $pattern = $candidate.GetCurrentPattern([Windows.Automation.ScrollPattern]::Pattern)
            $scrollable = if ($Vertical) { $pattern.Current.VerticallyScrollable } else { $pattern.Current.HorizontallyScrollable }
            $area = $rect.Width * $rect.Height
            if ($scrollable -and $area -lt $bestArea) { $best = $candidate; $bestArea = $area }
        } catch {}
    }
    $best
}

function Get-OrcaScrollPercent($Pattern, [bool]$Vertical) {
    try {
        if ($Vertical) { return [double]$Pattern.Current.VerticalScrollPercent }
        [double]$Pattern.Current.HorizontalScrollPercent
    } catch {
        $null
    }
}

function Get-OrcaScrollViewSize($Pattern, [bool]$Vertical) {
    try {
        if ($Vertical) { return [double]$Pattern.Current.VerticalViewSize }
        [double]$Pattern.Current.HorizontalViewSize
    } catch {
        $null
    }
}

function Wait-OrcaScrollPercentChange($Pattern, [bool]$Vertical, $Before) {
    # Why: WPF and Chromium move the viewport after the call returns, so poll briefly for the new position.
    $stopwatch = [Diagnostics.Stopwatch]::StartNew()
    while ($true) {
        $after = Get-OrcaScrollPercent $Pattern $Vertical
        if ($after -ne $Before -or $stopwatch.ElapsedMilliseconds -ge 500) { return $after }
        Start-Sleep -Milliseconds 25
    }
}

# Moves a fraction of a page by scroll percentage, where one page is the visible share of the content.
function Invoke-OrcaScrollPercent($Pattern, [bool]$Vertical, [bool]$Forward, [double]$Pages, [double]$Before) {
    $viewSize = Get-OrcaScrollViewSize $Pattern $Vertical
    if ($null -eq $viewSize -or $viewSize -le 0 -or $viewSize -ge 100) { return $false }
    # Why: scroll percent spans the hidden part only, so one view is viewSize / (100 - viewSize) of that range.
    $step = $Pages * 100 * $viewSize / (100 - $viewSize)
    $target = [Math]::Min(100.0, [Math]::Max(0.0, $(if ($Forward) { $Before + $step } else { $Before - $step })))
    if ($target -eq $Before) { return $true }
    $unchanged = [Windows.Automation.ScrollPattern]::NoScroll
    try {
        if ($Vertical) { $Pattern.SetScrollPercent($unchanged, $target) } else { $Pattern.SetScrollPercent($target, $unchanged) }
    } catch {
        return $false
    }
    [void](Wait-OrcaScrollPercentChange $Pattern $Vertical $Before)
    $true
}

function Invoke-OrcaScrollPattern($Element, $RootElement, [string]$Direction, [double]$Pages) {
    if ($null -eq $Element) { return $false }
    $vertical = $Direction -in @("up", "down")
    $forward = $Direction -in @("down", "right")
    $pattern = Get-OrcaScrollPattern $Element $RootElement $vertical
    if ($null -eq $pattern) { return $false }
    # Why: without a readable position nothing can tell the end of the content from a refused scroll.
    $before = Get-OrcaScrollPercent $pattern $vertical
    if ($null -eq $before -or $before -lt 0) { return $false }
    if ($Pages -ne [Math]::Floor($Pages)) { return Invoke-OrcaScrollPercent $pattern $vertical $forward $Pages $before }
    $amount = if ($forward) { [Windows.Automation.ScrollAmount]::LargeIncrement } else { [Windows.Automation.ScrollAmount]::LargeDecrement }
    $none = [Windows.Automation.ScrollAmount]::NoAmount
    for ($page = 0; $page -lt $Pages; $page++) {
        try {
            if ($vertical) { $pattern.Scroll($none, $amount) } else { $pattern.Scroll($amount, $none) }
        } catch {
            # Why: a refusal before any page moved means ScrollPattern can't do it; after that it is the end of the content.
            return $page -gt 0
        }
        # Why: an unmoved or unreadable percent after the wait is the end of the content.
        $after = Wait-OrcaScrollPercentChange $pattern $vertical $before
        if ($null -eq $after -or $after -eq $before) { break }
        $before = $after
    }
    $true
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

function Assert-OrcaElementFound($Element, $Record) {
    if ($null -ne $Record -and $null -eq $Element) { throw "stale element frame; run get-app-state again and use a fresh element index" }
}

# Screen point for real mouse input: the element's center when the request names one, else window-local x/y.
function Get-OrcaPointerPoint($Element, $Record, $X, $Y, [string]$XName, [string]$YName, $WindowFrame) {
    if ($null -ne $Record) {
        $point = Get-OrcaElementScreenPoint $Element
        if ($null -eq $point) { throw "stale element frame; run get-app-state again and use a fresh element index" }
        return $point
    }
    @{
        x = [int][Math]::Round($WindowFrame.x + (Get-OrcaRequiredNumber $X $XName))
        y = [int][Math]::Round($WindowFrame.y + (Get-OrcaRequiredNumber $Y $YName))
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

function Send-OrcaMouseClick([int]$ScreenX, [int]$ScreenY, [string]$Button, [int]$Count, [string]$Modifiers) {
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

function Send-OrcaDrag($From, $To) {
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

function ConvertTo-OrcaSendKeysHotkey([string]$KeySpec) {
    $parts = @($KeySpec.Split("+") | ForEach-Object { $_.Trim() } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if ($parts.Count -eq 0) { throw "Unsupported key: $KeySpec" }
    $key = $parts[$parts.Count - 1]
    $prefix = ""
    if ($parts.Count -gt 1) {
        # SendKeys adds Shift for an uppercase letter, turning Ctrl+A into Ctrl+Shift+A.
        if ($key.Length -eq 1) { $key = $key.ToLowerInvariant() }
        foreach ($modifier in $parts[0..($parts.Count - 2)]) {
            $prefix += ConvertTo-OrcaSendKeysModifier $modifier
        }
    }
    $prefix + (ConvertTo-OrcaSendKeysKey $key)
}

function Send-OrcaHotkey([IntPtr]$WindowHandle, [string]$KeySpec) {
    $keys = ConvertTo-OrcaSendKeysHotkey $KeySpec
    [void][OrcaDesktopWin32]::SetForegroundWindow($WindowHandle)
    [System.Windows.Forms.SendKeys]::SendWait($keys)
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
    if ($Operation.tool -eq "get_app_state") {
        return [pscustomobject]@{ ok = $true; snapshot = New-OrcaSnapshot $Operation.app $includeScreenshot $Operation.windowId $Operation.windowIndex ([bool]$Operation.restoreWindow) $Operation.root }
    }

    $process = Find-OrcaProcess $Operation.app
    Assert-OrcaInputAllowed $process
    Assert-OrcaWindowTarget $process $Operation.windowId $Operation.windowIndex
    $root = Get-OrcaRootElement $process
    $restoreWindow = [bool]$Operation.restoreWindow
    $windowFrame = if ($null -ne $Operation.windowBounds) { $Operation.windowBounds } else { Get-OrcaWindowFrame $process $root }
    $element = Find-OrcaElement $root $Operation.element
    $fromElement = Find-OrcaElement $root $Operation.fromElement
    $toElement = Find-OrcaElement $root $Operation.toElement
    $handle = [IntPtr]$process.MainWindowHandle
    if ($Operation.tool -in @("type_text", "press_key", "hotkey", "paste_text")) {
        $restoreFailure = if ($restoreWindow) { Restore-OrcaWindow $process $root } else { $null }
        Assert-OrcaKeyboardFocus $handle $Operation $restoreFailure
    }
    $foregroundBefore = [OrcaDesktopWin32]::GetForegroundWindow()
    # Why: a stale or frameless target must fail before any refusal or raise; a minimized window has no frames until restored.
    $validatePointsBeforeRaise = -not [OrcaDesktopWin32]::IsIconic($handle)
    $action = $null

    switch ($Operation.tool) {
        "click" {
            Assert-OrcaElementFound $element $Operation.element
            $clickCount = Get-OrcaPositiveInteger $Operation.click_count "click_count"
            $button = if ([string]::IsNullOrWhiteSpace([string]$Operation.mouse_button)) { "left" } else { ([string]$Operation.mouse_button).ToLowerInvariant() }
            if ($button -notin @("left", "right", "middle")) { throw "unsupported mouse button: $($Operation.mouse_button)" }
            [void](Get-OrcaClickModifierVirtualKeys $Operation.modifiers)
            if ($null -ne $element -and (Test-OrcaElementDisabled $element)) {
                throw "element_not_enabled: element $($Operation.element.index) is disabled, so no input was sent; do what enables it first, then run get-app-state and retry once its line no longer lists disabled"
            }
            $pointerNeed = if (-not [string]::IsNullOrWhiteSpace([string]$Operation.modifiers)) { "a click with modifiers needs the real mouse and keyboard" }
                elseif ($button -eq "right") { "a right-click needs the real mouse" }
                elseif ($button -eq "middle") { "a middle-click needs the real mouse" }
                elseif ($clickCount -gt 1) { "a double or multi-click needs the real mouse" }
                elseif ($null -eq $Operation.element) { "a click by coordinates needs the real mouse" }
                else { $null }
            if ($null -eq $pointerNeed) {
                if (Invoke-OrcaPrimaryAction $element $Operation.element.index) {
                    $action = [pscustomobject]@{ path = "accessibility"; actionName = "primaryAction"; fallbackReason = $null }
                    break
                }
                $pointerNeed = "element $($Operation.element.index) has no Invoke, Select or Toggle action, so clicking it needs the real mouse"
            }
            if ($validatePointsBeforeRaise) { [void](Get-OrcaPointerPoint $element $Operation.element $Operation.x $Operation.y "x" "y" $windowFrame) }
            if (-not $restoreWindow) {
                $alternative = if ($null -eq $Operation.element) { "Click an element by --element-index instead when it lists Invoke, Select or Toggle." } else { "For a text field, use set-value instead." }
                throw (New-OrcaForegroundRefusal $process $pointerNeed $alternative)
            }
            $windowFrame = Restore-OrcaPointerWindow $process $root
            $point = Get-OrcaPointerPoint $element $Operation.element $Operation.x $Operation.y "x" "y" $windowFrame
            $cursor = Get-OrcaCursorPosition
            try {
                Send-OrcaMouseClick $point.x $point.y $button $clickCount $Operation.modifiers
            } finally {
                Restore-OrcaCursorPosition $cursor
            }
            $action = [pscustomobject]@{ path = "synthetic"; actionName = $null; fallbackReason = "actionUnsupported" }
        }
        "perform_secondary_action" {
            if ($null -eq $element) { throw "unknown element_index" }
            if (-not (Invoke-OrcaNamedAction $element $Operation.action)) {
                throw "$($Operation.action) is not a valid secondary action"
            }
            $action = [pscustomobject]@{ path = "accessibility"; actionName = $Operation.action; fallbackReason = $null }
        }
        "scroll" {
            $pages = Get-OrcaPositiveNumber $Operation.pages "pages"
            $delta = 120 * [int][Math]::Ceiling($pages)
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
            Assert-OrcaElementFound $element $Operation.element
            $scrollTarget = $element
            if ($null -eq $Operation.element) {
                $at = Get-OrcaPointerPoint $null $null $Operation.x $Operation.y "x" "y" $windowFrame
                $scrollTarget = Find-OrcaScrollContainerAt $root $at.x $at.y ($Operation.direction -in @("up", "down"))
            }
            if (Invoke-OrcaScrollPattern $scrollTarget $root $Operation.direction $pages) {
                $action = [pscustomobject]@{ path = "accessibility"; actionName = "scroll"; fallbackReason = $null }
                break
            }
            if ($validatePointsBeforeRaise) { [void](Get-OrcaPointerPoint $element $Operation.element $Operation.x $Operation.y "x" "y" $windowFrame) }
            if (-not $restoreWindow) {
                $where = if ($null -ne $Operation.element) { "element $($Operation.element.index)" } else { "that point" }
                throw (New-OrcaForegroundRefusal $process "nothing under $where scrolls $($Operation.direction) through UI Automation, so this scroll needs the real mouse wheel")
            }
            # Why: the wheel scrolls whatever is under the pointer, so the window must be on top.
            $windowFrame = Restore-OrcaPointerWindow $process $root
            $point = Get-OrcaPointerPoint $element $Operation.element $Operation.x $Operation.y "x" "y" $windowFrame
            $cursor = Get-OrcaCursorPosition
            try {
                [void][OrcaDesktopWin32]::SetCursorPos([int]$point.x, [int]$point.y)
                [OrcaDesktopWin32]::mouse_event($mouseEvent, 0, 0, $delta, [UIntPtr]::Zero)
            } finally {
                Restore-OrcaCursorPosition $cursor
            }
            $fallbackReason = if ($null -ne $Operation.element) { "actionUnsupported" } else { $null }
            $action = [pscustomobject]@{ path = "synthetic"; actionName = "scroll"; fallbackReason = $fallbackReason }
        }
        "drag" {
            Assert-OrcaElementFound $fromElement $Operation.fromElement
            Assert-OrcaElementFound $toElement $Operation.toElement
            if ($validatePointsBeforeRaise) {
                [void](Get-OrcaPointerPoint $fromElement $Operation.fromElement $Operation.from_x $Operation.from_y "from_x" "from_y" $windowFrame)
                [void](Get-OrcaPointerPoint $toElement $Operation.toElement $Operation.to_x $Operation.to_y "to_x" "to_y" $windowFrame)
            }
            if (-not $restoreWindow) {
                throw (New-OrcaForegroundRefusal $process "a drag needs the real mouse, because UI Automation has no drag")
            }
            $windowFrame = Restore-OrcaPointerWindow $process $root
            $from = Get-OrcaPointerPoint $fromElement $Operation.fromElement $Operation.from_x $Operation.from_y "from_x" "from_y" $windowFrame
            $to = Get-OrcaPointerPoint $toElement $Operation.toElement $Operation.to_x $Operation.to_y "to_x" "to_y" $windowFrame
            $cursor = Get-OrcaCursorPosition
            try {
                Send-OrcaDrag $from $to
            } finally {
                Restore-OrcaCursorPosition $cursor
            }
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
            $written = if ($null -ne $element) { Set-OrcaElementValue $element ([string]$Operation.value) } else { $null }
            if ($null -eq $written) {
                throw "element value is not settable"
            }
            $action = [pscustomobject]@{ path = "accessibility"; actionName = "setValue"; fallbackReason = $null }
            if ($null -ne $written.verification) {
                $action | Add-Member -NotePropertyName verification -NotePropertyValue $written.verification
            }
        }
        default {
            throw "unsupported tool: $($Operation.tool)"
        }
    }

    try {
        try {
            $snapshot = New-OrcaSnapshot $Operation.app $includeScreenshot $Operation.windowId $Operation.windowIndex
        } catch {
            if ($_.Exception.Message -like "window_not_responding:*") { throw }
            if ($null -eq $Operation.windowId -and $null -eq $Operation.windowIndex) { throw }
            if ($null -eq $action.verification) {
                $action | Add-Member -NotePropertyName verification -NotePropertyValue ([pscustomobject]@{ state = "unverified"; reason = "window_changed" })
            }
            $snapshot = New-OrcaSnapshot $Operation.app $includeScreenshot $null $null
        }
    } catch {
        # Why: the input was already sent, so the pre-action "nothing was sent" wording would invite a duplicate retry.
        if ($_.Exception.Message -like "window_not_responding:*") {
            throw "window_not_responding: $(Get-OrcaAppName $process) stopped responding after the action was sent; the action may already have been delivered"
        }
        throw
    }
    # Why: real mouse and key input needs the target in front. WPF and others activate their own window for UIA patterns,
    # sometimes after the call returns, so those are measured once the observe above has given them time.
    $delivery = if ($action.path -eq "accessibility" -and -not (Test-OrcaTargetTookForeground $foregroundBefore $process)) { "background" } else { "foreground" }
    $action | Add-Member -NotePropertyName delivery -NotePropertyValue $delivery
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
