param(
    [Parameter(Mandatory = $true)]
    [string]$OperationPath
)

$ErrorActionPreference = "Stop"
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
}
"@

$MaxNodes = 1200
$MaxDepth = 64
$TextLimit = 500
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

function Assert-OrcaKeyboardFocus([IntPtr]$WindowHandle, $Operation) {
    if ([bool]$Operation.restoreWindow) { return }
    if ([OrcaDesktopWin32]::GetForegroundWindow() -eq $WindowHandle) { return }
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

function Get-OrcaValueText($Element) {
    try {
        if ($Element.Current.IsPassword) { return "[redacted]" }
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
        nativeWindowHandle = $nativeWindowHandle
        frame = Get-OrcaElementFrame $Element $WindowFrame
        actions = @(Get-OrcaActions $Element)
    }
}

function Render-OrcaTree($RootElement, $WindowFrame) {
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
        $snippets = @(Get-OrcaTextSnippets $Node 8 4)
        $genericSummary = $null
        if (($roleKey -in @("pane", "group", "custom", "unknown")) -and [string]::IsNullOrWhiteSpace($title) -and [string]::IsNullOrWhiteSpace($record.value) -and $snippets.Count -ge 2 -and (Test-OrcaPlainTextSubtree $Node)) {
            $genericSummary = ($snippets -join " ")
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
        for ($i = 0; $i -lt $children.Count; $i++) {
            Visit-OrcaNode $children.Item($i) ($Depth + 1)
        }
    }

    Visit-OrcaNode $RootElement 0
    [pscustomobject]@{ elements = @($records.ToArray()); lines = @($lines.ToArray()); truncation = $truncation }
}

function Get-OrcaScreenshot([bool]$IncludeScreenshot, $WindowFrame) {
    if (-not $IncludeScreenshot -or $null -eq $WindowFrame) { return $null }
    try {
        $width = [int][Math]::Max(1, [Math]::Round($WindowFrame.width))
        $height = [int][Math]::Max(1, [Math]::Round($WindowFrame.height))
        $bitmap = New-Object System.Drawing.Bitmap $width, $height
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $graphics.CopyFromScreen([int][Math]::Round($WindowFrame.x), [int][Math]::Round($WindowFrame.y), 0, 0, $bitmap.Size)
        $stream = New-Object System.IO.MemoryStream
        $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
        $bytes = $stream.ToArray()
        $graphics.Dispose()
        $bitmap.Dispose()
        $stream.Dispose()
        [Convert]::ToBase64String($bytes)
    } catch {
        $null
    }
}

function New-OrcaSnapshot([string]$Query, [bool]$IncludeScreenshot, $WindowId = $null, $WindowIndex = $null, [bool]$RestoreWindow = $false) {
    $process = Find-OrcaProcess $Query
    if ($RestoreWindow) { Restore-OrcaWindow $process }
    Assert-OrcaWindowTarget $process $WindowId $WindowIndex
    $root = Get-OrcaRootElement $process
    $windowFrame = Get-OrcaWindowFrame $process $root
    $tree = Render-OrcaTree $root $windowFrame

    [pscustomobject]@{
        snapshotId = [guid]::NewGuid().ToString()
        app = New-OrcaAppRecord $process
        windowTitle = $process.MainWindowTitle
        windowId = Get-OrcaWindowId $process
        windowBounds = $windowFrame
        screenshotPngBase64 = Get-OrcaScreenshot $IncludeScreenshot $windowFrame
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

function Get-OrcaScreenPoint($Operation, $WindowFrame) {
    if ($null -ne $Operation.element) {
        throw "stale element frame; run get-app-state again and use a fresh element index"
    }
    @{
        x = [int][Math]::Round($WindowFrame.x + [double]$Operation.x)
        y = [int][Math]::Round($WindowFrame.y + [double]$Operation.y)
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

function Send-OrcaMouseClick([IntPtr]$WindowHandle, [int]$ScreenX, [int]$ScreenY, [string]$Button, [int]$Count) {
    [void][OrcaDesktopWin32]::SetForegroundWindow($WindowHandle)
    [void][OrcaDesktopWin32]::SetCursorPos($ScreenX, $ScreenY)
    $down = $MouseEvents.LeftDown
    $up = $MouseEvents.LeftUp
    if ($Button -eq "right") {
        $down = $MouseEvents.RightDown
        $up = $MouseEvents.RightUp
    } elseif ($Button -eq "middle") {
        $down = $MouseEvents.MiddleDown
        $up = $MouseEvents.MiddleUp
    }

    for ($i = 0; $i -lt [Math]::Max(1, $Count); $i++) {
        [OrcaDesktopWin32]::mouse_event($down, 0, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 35
        [OrcaDesktopWin32]::mouse_event($up, 0, 0, 0, [UIntPtr]::Zero)
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
            $handledByPattern = $false
            if ($null -ne $element -and $Operation.mouse_button -ne "right" -and $Operation.mouse_button -ne "middle" -and [int]$Operation.click_count -le 1) {
                $handledByPattern = Invoke-OrcaPrimaryAction $element
            }
            if (-not $handledByPattern) {
                $point = Get-OrcaElementScreenPoint $element
                if ($null -eq $point) { $point = Get-OrcaScreenPoint $Operation $windowFrame }
                Send-OrcaMouseClick $handle $point.x $point.y $Operation.mouse_button ([int]$Operation.click_count)
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
            $delta = 120 * [int][Math]::Max(1, [Math]::Ceiling([double]$Operation.pages))
            if ($Operation.direction -eq "down" -or $Operation.direction -eq "right") { $delta = -1 * $delta }
            $point = Get-OrcaElementScreenPoint $element
            if ($null -eq $point) { $point = Get-OrcaScreenPoint $Operation $windowFrame }
            [void][OrcaDesktopWin32]::SetForegroundWindow($handle)
            [void][OrcaDesktopWin32]::SetCursorPos([int]$point.x, [int]$point.y)
            [OrcaDesktopWin32]::mouse_event($MouseEvents.Wheel, 0, 0, $delta, [UIntPtr]::Zero)
            $action = [pscustomobject]@{ path = "synthetic"; actionName = "scroll"; fallbackReason = $null }
        }
        "drag" {
            $from = Get-OrcaElementScreenPoint $fromElement
            if ($null -eq $from -and $null -ne $Operation.fromElement) { throw "stale element frame; run get-app-state again and use a fresh element index" }
            if ($null -eq $from) { $from = @{ x = $windowFrame.x + [double]$Operation.from_x; y = $windowFrame.y + [double]$Operation.from_y } }
            $to = Get-OrcaElementScreenPoint $toElement
            if ($null -eq $to -and $null -ne $Operation.toElement) { throw "stale element frame; run get-app-state again and use a fresh element index" }
            if ($null -eq $to) { $to = @{ x = $windowFrame.x + [double]$Operation.to_x; y = $windowFrame.y + [double]$Operation.to_y } }
            Send-OrcaDrag $handle $from $to
            $action = [pscustomobject]@{ path = "synthetic"; actionName = "drag"; fallbackReason = $null }
        }
        "type_text" {
            Send-OrcaText $handle ([string]$Operation.text)
            $action = [pscustomobject]@{ path = "synthetic"; actionName = "typeText"; fallbackReason = $null }
        }
        "press_key" {
            Send-OrcaKey $handle ([string]$Operation.key)
            $action = [pscustomobject]@{ path = "synthetic"; actionName = "pressKey"; fallbackReason = $null }
        }
        "hotkey" {
            Send-OrcaHotkey $handle ([string]$Operation.key)
            $action = [pscustomobject]@{ path = "synthetic"; actionName = "hotkey"; fallbackReason = $null; verification = [pscustomobject]@{ state = "unverified"; reason = "synthetic_input" } }
        }
        "paste_text" {
            Send-OrcaPasteText $handle ([string]$Operation.text)
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

try {
    $operation = Read-OrcaOperation $OperationPath
    Write-OrcaJson (Invoke-OrcaOperation $operation)
} catch {
    Write-OrcaJson ([pscustomobject]@{ ok = $false; error = [string]$_.Exception.Message })
}
