$ErrorActionPreference = "Stop"

function Assert-TestEqual($Actual, $Expected, [string]$Label) {
    if ($Actual -ne $Expected) {
        throw "$Label expected '$Expected', received '$Actual'"
    }
}

Add-Type -TypeDefinition @"
using System.Collections;
using System.Collections.Generic;

public sealed class OrcaRenderTestCounter {
    public int FindAll;
}

public sealed class OrcaRenderTestBounds {
    public bool IsEmpty = true;
    public double X;
    public double Y;
    public double Width;
    public double Height;
}

public sealed class OrcaRenderTestControlType {
    public string ProgrammaticName = "";
}

public sealed class OrcaRenderTestCurrent {
    public string AutomationId = "";
    public OrcaRenderTestBounds BoundingRectangle = new OrcaRenderTestBounds();
    public string ClassName = "fake";
    public OrcaRenderTestControlType ControlType = new OrcaRenderTestControlType();
    public bool IsPassword;
    public string LocalizedControlType = "";
    public string Name = "";
    public long NativeWindowHandle;
}

public sealed class OrcaRenderTestPatternCurrent {
    public bool IsSelected;
    public string Value = "";
}

public sealed class OrcaRenderTestPattern {
    public OrcaRenderTestPatternCurrent Current = new OrcaRenderTestPatternCurrent();
}

public sealed class OrcaRenderTestCollection : IEnumerable {
    private readonly OrcaRenderTestElement[] values;

    public OrcaRenderTestCollection(OrcaRenderTestElement[] values) {
        this.values = values;
    }

    public int Count {
        get { return values.Length; }
    }

    public OrcaRenderTestElement Item(int index) {
        return values[index];
    }

    public IEnumerator GetEnumerator() {
        return values.GetEnumerator();
    }
}

public sealed class OrcaRenderTestElement {
    public readonly List<OrcaRenderTestElement> Children =
        new List<OrcaRenderTestElement>();
    public OrcaRenderTestCounter Counter = new OrcaRenderTestCounter();
    public readonly OrcaRenderTestCurrent Current = new OrcaRenderTestCurrent();
    public bool FailFindAll;
    public int RuntimeIdValue;
    public string ValueText = "";

    public OrcaRenderTestCollection FindAll(object scope, object condition) {
        Counter.FindAll++;
        if (FailFindAll) {
            throw new System.InvalidOperationException("defunct node");
        }
        return new OrcaRenderTestCollection(Children.ToArray());
    }

    public OrcaRenderTestPattern GetCurrentPattern(object pattern) {
        OrcaRenderTestPattern result = new OrcaRenderTestPattern();
        result.Current.Value = ValueText;
        return result;
    }

    public int[] GetRuntimeId() {
        return new int[] { RuntimeIdValue };
    }

    public object[] GetSupportedPatterns() {
        return new object[0];
    }
}
"@

function New-TestCounter {
    New-Object -TypeName OrcaRenderTestCounter
}

function New-TestElement {
    param(
        [string]$Role,
        [string]$Name = "",
        [string]$Value = "",
        [object[]]$Children = @(),
        $Counter = $(New-TestCounter),
        [switch]$FailFindAll,
        [int]$RuntimeId = 1
    )
    $element = New-Object -TypeName OrcaRenderTestElement
    $element.Counter = $Counter
    $element.FailFindAll = [bool]$FailFindAll
    $element.RuntimeIdValue = $RuntimeId
    $element.ValueText = $Value
    $element.Current.ControlType.ProgrammaticName = $Role
    $element.Current.LocalizedControlType = $Role
    $element.Current.Name = $Name
    foreach ($child in @($Children)) {
        [void]$element.Children.Add($child)
    }
    $element
}

$operationPath = Join-Path ([IO.Path]::GetTempPath()) ("orca-runtime-render-test-" + [guid]::NewGuid() + ".json")
try {
    Set-Content -LiteralPath $operationPath -Encoding UTF8 -Value '{"tool":"handshake"}'
    $runtimeOutput = . (Join-Path $PSScriptRoot "runtime.ps1") -OperationPath $operationPath
    $handshake = $runtimeOutput | ConvertFrom-Json
    Assert-TestEqual $handshake.ok $true "runtime handshake"

    $counter = New-TestCounter
    $leaf = New-TestElement -Role "text" -Name "unused" -Counter $counter -RuntimeId 2
    $root = New-TestElement -Role "button" -Name "Save" -Children @($leaf) -Counter $counter
    $tree = Render-OrcaTree $root $null
    Assert-TestEqual $tree.elements.Count 1 "named control record count"
    Assert-TestEqual ([string]$tree.lines[0]) "0 button Save" "named control line"
    Assert-TestEqual $counter.findAll 1 "named control child enumeration"

    $counter = New-TestCounter
    $leaf = New-TestElement -Role "text" -Name "body" -Counter $counter -RuntimeId 2
    $root = New-TestElement -Role "group" -Name "Details" -Children @($leaf) -Counter $counter
    $tree = Render-OrcaTree $root $null
    Assert-TestEqual (($tree.elements | ForEach-Object { $_.name }) -join "|") "Details|body" "named generic records"
    Assert-TestEqual (@($tree.lines) -join "|") "0 group Details|`t1 text body" "named generic lines"
    Assert-TestEqual $counter.findAll 2 "named generic child enumeration"

    $counter = New-TestCounter
    $alpha = New-TestElement -Role "text" -Name "Alpha" -Counter $counter -RuntimeId 2
    $beta = New-TestElement -Role "text" -Name "Beta" -Counter $counter -RuntimeId 3
    $root = New-TestElement -Role "group" -Children @($alpha, $beta) -Counter $counter
    $tree = Render-OrcaTree $root $null
    Assert-TestEqual $tree.elements.Count 1 "anonymous generic record count"
    Assert-TestEqual ([string]$tree.lines[0]) "0 group, Text: Alpha Beta" "anonymous generic summary"
    Assert-TestEqual $counter.findAll 7 "anonymous generic child enumeration"

    $counter = New-TestCounter
    $alpha = New-TestElement -Role "text" -Name "Alpha" -Counter $counter -RuntimeId 2
    $beta = New-TestElement -Role "text" -Name "Beta" -Counter $counter -RuntimeId 3
    $root = New-TestElement -Role "row" -Name "Invoice" -Children @($alpha, $beta) -Counter $counter
    $tree = Render-OrcaTree $root $null
    Assert-TestEqual (($tree.elements | ForEach-Object { $_.name }) -join "|") "Invoice|Alpha|Beta" "row records"
    Assert-TestEqual ([string]$tree.lines[0]) "0 row Invoice, Text: Alpha Beta" "row summary"
    Assert-TestEqual $counter.findAll 6 "row child enumeration"

    $counter = New-TestCounter
    $button = New-TestElement -Role "button" -Name "Continue" -Counter $counter -RuntimeId 2
    $root = New-TestElement -Role "group" -Children @($button) -Counter $counter
    $tree = Render-OrcaTree $root $null
    Assert-TestEqual $tree.elements.Count 1 "elided wrapper record count"
    Assert-TestEqual ([string]$tree.lines[0]) "0 button Continue" "elided wrapper line"
    Assert-TestEqual $counter.findAll 4 "elided wrapper child enumeration"

    $counter = New-TestCounter
    $root = New-TestElement -Role "row" -Name "Invoice" -Counter $counter -FailFindAll
    $tree = Render-OrcaTree $root $null
    Assert-TestEqual $tree.elements.Count 1 "failed child read record count"
    Assert-TestEqual ([string]$tree.lines[0]) "0 row Invoice" "failed child read line"
    Assert-TestEqual $counter.findAll 2 "failed child read retries"

    $originalMaxNodes = $MaxNodes
    try {
        $MaxNodes = 3
        $counter = New-TestCounter
        $children = @()
        for ($index = 0; $index -lt 3; $index++) {
            $children += New-TestElement -Role "text" -Name "Item $index" -Counter $counter -RuntimeId ($index + 2)
        }
        $root = New-TestElement -Role "document" -Name "Results" -Children $children -Counter $counter
        $tree = Render-OrcaTree $root $null
        Assert-TestEqual $tree.elements.Count 3 "node limit record count"
        Assert-TestEqual ([string]$tree.elements[-1].name) "Item 1" "node limit prefix"
        Assert-TestEqual $tree.truncation.truncated $true "node limit truncation"
        Assert-TestEqual $tree.truncation.maxDepthReached $false "node limit depth flag"
    } finally {
        $MaxNodes = $originalMaxNodes
    }

    $originalMaxDepth = $MaxDepth
    try {
        $MaxDepth = 2
        $counter = New-TestCounter
        $root = New-TestElement -Role "document" -Name "Depth 3" -Counter $counter -RuntimeId 4
        for ($depth = 2; $depth -ge 0; $depth--) {
            $root = New-TestElement -Role "document" -Name "Depth $depth" -Children @($root) -Counter $counter -RuntimeId ($depth + 1)
        }
        $tree = Render-OrcaTree $root $null
        Assert-TestEqual $tree.elements.Count 3 "depth limit record count"
        Assert-TestEqual ([string]$tree.elements[-1].name) "Depth 2" "depth limit prefix"
        Assert-TestEqual $tree.truncation.truncated $true "depth limit truncation"
        Assert-TestEqual $tree.truncation.maxDepthReached $true "depth limit flag"
    } finally {
        $MaxDepth = $originalMaxDepth
    }

    # Desktop App pane input helpers that run before any window message is posted.
    $target = [pscustomobject]@{ handle = [IntPtr]::Zero; info = [pscustomobject]@{ X = 100; Y = 50; Width = 400; Height = 300 } }
    $point = Get-OrcaDesktopScreenPoint $target ([pscustomobject]@{ x = 10.4; y = 20.6 })
    Assert-TestEqual "$($point.x),$($point.y)" "110,71" "desktop point is window-relative"
    $outside = $null
    try { Get-OrcaDesktopScreenPoint $target ([pscustomobject]@{ x = 400; y = 1 }) | Out-Null } catch { $outside = $_.Exception.Message }
    Assert-TestEqual ($outside -like "invalid_argument:*") $true "desktop point outside window is rejected"
    $missingPid = $null
    try { Get-OrcaDesktopId $null "pid" | Out-Null } catch { $missingPid = $_.Exception.Message }
    Assert-TestEqual $missingPid "pid is required" "desktop pid never defaults"
    Assert-TestEqual (Get-OrcaDesktopVirtualKey "pagedown") 0x22 "desktop page down key"
    Assert-TestEqual (Get-OrcaDesktopVirtualKey "forwarddelete") 0x2E "desktop forward delete key"
    Assert-TestEqual (Get-OrcaDesktopVirtualKey "f5") 0x74 "desktop function key"
    $chord = $null
    try { Send-OrcaDesktopKey $target "shift+cmd+z" } catch { $chord = $_.Exception.Message }
    Assert-TestEqual ($chord -like "unsupported capability:*") $true "desktop unsupported chord degrades"
    $presses = @(1, 2, 3 | ForEach-Object { Get-OrcaDesktopPressMessage $_ 0x0201 0x0203 })
    Assert-TestEqual ($presses -join ",") "513,515,513" "desktop click sends one press, DBLCLK on the second"
    $windowsCount = @(Get-OrcaDesktopWindows $PID).Count
    Assert-TestEqual ($windowsCount -ge 0) $true "desktop window list runs"

    Write-Output "windows-snapshot-render-tests-ok"
} finally {
    Remove-Item -LiteralPath $operationPath -Force -ErrorAction SilentlyContinue
}
