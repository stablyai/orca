$ErrorActionPreference = "Stop"
$script:mismatchCases = 0
$script:matchCases = 0

function Assert-GuardEqual($Actual, $Expected, [string]$Label) {
    if ($Actual -cne $Expected) { throw "$Label failed" }
}

function Assert-GuardFailure($Operation) {
    $script:effects.Clear()
    try {
        Invoke-OrcaOperation $Operation | Out-Null
    } catch {
        Assert-GuardEqual $_.Exception.Message "precondition_failed" "private precondition error"
        Assert-GuardEqual $script:effects.Count 0 "no UI effect or success snapshot on mismatch"
        $script:mismatchCases++
        return
    }
    throw "Expected precondition_failed"
}

function New-TestGuardNode([int]$Id, [string]$Name, [string]$Value) {
    $node = [pscustomobject]@{
        id = $Id
        children = @()
        Current = [pscustomobject]@{
            Name = $Name
            AutomationId = "field"
            ControlType = [pscustomobject]@{ ProgrammaticName = "ControlType.Edit" }
            ClassName = "TestField"
            NativeWindowHandle = 0
            IsEnabled = $true
            IsOffscreen = $false
            IsPassword = $false
            BoundingRectangle = [pscustomobject]@{ X = 110; Y = 220; Width = 40; Height = 20 }
        }
        value = $Value
    }
    $node | Add-Member ScriptMethod GetRuntimeId { @(4, $this.id) }
    $node | Add-Member ScriptMethod GetCurrentPropertyValue {
        param($Property)
        $Property -eq [Windows.Automation.AutomationElement]::IsValuePatternAvailableProperty
    }
    $node | Add-Member ScriptMethod GetSupportedPatterns {
        @([Windows.Automation.ValuePattern]::Pattern, [Windows.Automation.InvokePattern]::Pattern)
    }
    $node | Add-Member ScriptMethod GetCurrentPattern {
        param($Pattern)
        $script:patternOwner = $this
        $pattern = [pscustomobject]@{ Current = [pscustomobject]@{ Value = $this.value; IsReadOnly = $false } }
        $pattern | Add-Member ScriptMethod SetValue {
            param($Value)
            $script:effects.Add("set")
            $script:patternOwner.value = $Value
        }
        $pattern | Add-Member ScriptMethod Invoke {
            if ($script:humanRace) { $script:process.MainWindowTitle = "human switched document after validation" }
            $script:effects.Add("invoke")
        }
        $pattern
    }
    $node | Add-Member ScriptMethod FindAll {
        param($Scope, $Condition)
        $nodes = $this.children
        $collection = [pscustomobject]@{ Count = $nodes.Count; nodes = $nodes }
        $collection | Add-Member ScriptMethod Item { param($Index) $this.nodes[$Index] }
        $collection
    }
    $node
}

$operationPath = Join-Path ([IO.Path]::GetTempPath()) ("orca-runtime-guard-test-" + [guid]::NewGuid() + ".json")
try {
    Set-Content -LiteralPath $operationPath -Encoding UTF8 -Value '{"tool":"handshake"}'
    $handshake = (. (Join-Path $PSScriptRoot "runtime.ps1") -OperationPath $operationPath) | ConvertFrom-Json
    Assert-GuardEqual $handshake.capabilities.guardedActions.humanInputAtomic $false "truthful human capability"
    $script:effects = New-Object 'System.Collections.Generic.List[string]'
    $script:humanRace = $false
    $script:process = [pscustomobject]@{ Id = 100; MainWindowHandle = 99; MainWindowTitle = "private document" }
    $script:field = New-TestGuardNode 2 "private target label" ""
    $script:root = New-TestGuardNode 1 "private tree text" ""
    $script:root.children = @($script:field)
    function Find-OrcaProcess($App) {
        if ($App -ne "Test") { throw "private app mismatch" }
        $script:process
    }
    function Restore-OrcaWindow($Process) { $script:effects.Add("restore") }
    function Get-OrcaRootElement($Process) { $script:root }
    function Get-OrcaWindowFrame($Process, $Root) { @{ x = 100; y = 200; width = 300; height = 200 } }
    function Get-OrcaScreenshot($Include, $Frame) { $null }
    function Test-OrcaBrowserProcess($Process) { $false }
    function New-OrcaAppRecord($Process) { [pscustomobject]@{ name = "Test"; pid = $Process.Id } }
    function Render-OrcaTree($Root, $Frame) {
        [pscustomobject]@{
            elements = @([pscustomobject]@{ index = 1; runtimeId = @(4, 2); value = $script:field.value })
            lines = @("private rendered text")
            truncation = [pscustomobject]@{ truncated = $false }
        }
    }
    function Send-OrcaMouseClick($Handle, $X, $Y, $Button, $Count, $Modifiers) {
        $script:effects.Add("mouse:$X,$Y")
    }
    function New-GuardOperation([string]$Tool = "click") {
        $snapshot = New-OrcaSnapshot "Test" $false
        @{ tool = $Tool; app = "Test"; windowId = 99; element = $snapshot.elements[0]; if_snapshot_id = $snapshot.snapshotId }
    }

    $operation = New-GuardOperation "set_value"
    $operation.value = "new private draft"
    $result = Invoke-OrcaOperation $operation
    Assert-GuardEqual ($script:effects -join "|") "set" "empty expected value succeeds"
    Assert-GuardEqual $result.action.precondition.state "matched" "matched receipt"
    Assert-GuardEqual $result.action.precondition.snapshotId $operation.if_snapshot_id "exact receipt ID"
    $script:matchCases++
    if ((ConvertTo-Json $result -Depth 8) -match "private|draft|document|target label|tree text") { throw "metadata leaked content" }

    $operation = New-GuardOperation
    $operation.guard_scope = "session:foreign"
    Assert-GuardFailure $operation
    $operation = New-GuardOperation
    $operation.element.value = "wrong prior value"
    Assert-GuardFailure $operation
    $operation = New-GuardOperation "set_value"
    $operation.value = "replacement"
    $script:field.value = "human changed private draft"
    Assert-GuardFailure $operation
    $operation = New-GuardOperation
    $script:process.MainWindowTitle = "another private document"
    Assert-GuardFailure $operation
    $operation = New-GuardOperation
    $script:root.Current.Name = "changed hidden tree marker"
    Assert-GuardFailure $operation
    $operation = New-GuardOperation
    $script:field.id = 3
    Assert-GuardFailure $operation
    $script:field.id = 2
    $operation = New-GuardOperation
    $operation.element.runtimeId = @(4, 999)
    Assert-GuardFailure $operation
    $operation = New-GuardOperation
    $operation.app = "foreign app"
    Assert-GuardFailure $operation
    $operation = New-GuardOperation
    $operation.windowId = 98
    Assert-GuardFailure $operation
    $operation = New-GuardOperation
    $script:process.Id = 101
    Assert-GuardFailure $operation
    $script:process.Id = 100
    $operation = New-GuardOperation
    $operation.if_snapshot_id = "unknown"
    Assert-GuardFailure $operation
    $operation = New-GuardOperation
    $script:OrcaSnapshotGuards[$operation.if_snapshot_id].createdAt = [DateTime]::UtcNow.AddMinutes(-3)
    Assert-GuardFailure $operation
    $operation = New-GuardOperation
    for ($index = 0; $index -lt 33; $index++) { New-OrcaSnapshot "Test" $false | Out-Null }
    Assert-GuardFailure $operation
    $operation = New-GuardOperation
    $script:OrcaSnapshotGuards.Clear()
    Assert-GuardFailure $operation
    $operation = New-GuardOperation
    $operation.restoreWindow = $true
    Assert-GuardFailure $operation
    $operation = New-GuardOperation
    $operation.physical = $true
    $script:field.Current.BoundingRectangle.Width = 0
    Assert-GuardFailure $operation
    $operation.x = 999
    $operation.y = 999
    Assert-GuardFailure $operation
    $script:field.Current.BoundingRectangle.Width = 40
    foreach ($extra in @(@{ modifiers = "Ctrl" }, @{ mouse_button = "right" }, @{ click_count = 2 })) {
        $operation = New-GuardOperation
        foreach ($key in $extra.Keys) { $operation[$key] = $extra[$key] }
        Assert-GuardFailure $operation
    }
    $operation = New-GuardOperation
    $script:effects.Clear()
    Invoke-OrcaOperation $operation | Out-Null
    Assert-GuardEqual ($script:effects -join "|") "invoke" "exact semantic click performs once"
    $script:matchCases++
    $operation = New-GuardOperation "perform_secondary_action"
    $operation.action = "invoke"
    $script:effects.Clear()
    Invoke-OrcaOperation $operation | Out-Null
    Assert-GuardEqual ($script:effects -join "|") "invoke" "guarded semantic submit"
    $script:matchCases++
    $operation = New-GuardOperation
    $script:humanRace = $true
    $script:effects.Clear()
    Invoke-OrcaOperation $operation | Out-Null
    Assert-GuardEqual ($script:effects -join "|") "invoke" "human final interval remains open"
    Assert-GuardEqual $script:process.MainWindowTitle "human switched document after validation" "race modeled honestly"
    $script:humanRace = $false
    $operation = New-GuardOperation
    $savedMaxNodes = $MaxNodes
    $MaxNodes = 1
    Assert-GuardFailure $operation
    $unusable = New-GuardOperation
    $MaxNodes = $savedMaxNodes
    Assert-GuardFailure $unusable
    Write-Output "Windows guarded runtime tests passed ($script:mismatchCases mismatch cases with zero effects; $script:matchCases exact matches with one effect; 1 human-input race remains open)"
} finally {
    Remove-Item -LiteralPath $operationPath -Force -ErrorAction SilentlyContinue
}
