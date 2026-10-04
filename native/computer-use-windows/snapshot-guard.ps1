# Process-local ownership: a restarted provider has no authority over old IDs.
$script:OrcaSnapshotGuards = [ordered]@{}
$script:OrcaGuardTtlMilliseconds = 120000
$script:OrcaGuardCapacity = 32

function Get-OrcaGuardHash([string]$Text) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        [Convert]::ToBase64String($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text)))
    } finally {
        $sha.Dispose()
    }
}

function Read-OrcaGuardValue($Element) {
    if ($Element.Current.IsPassword) { throw "precondition_failed" }
    if ($Element.GetCurrentPropertyValue([Windows.Automation.AutomationElement]::IsValuePatternAvailableProperty)) {
        $pattern = $Element.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern)
        return [string]$pattern.Current.Value
    }
    return ""
}

function Read-OrcaGuardState($Process, $Root) {
    # Traverse the full raw tree; presentation suppression must not hide changes.
    $nodes = New-Object 'System.Collections.Generic.List[object]'
    $values = @{}
    $identities = New-Object 'System.Collections.Generic.HashSet[string]'
    $budget = [pscustomobject]@{ characters = 0 }
    function Visit-OrcaGuardNode($Node, [int]$Depth, [string]$Parent) {
        if ($nodes.Count -ge $MaxNodes -or $Depth -gt $MaxDepth) { throw "precondition_failed" }
        $runtimeId = @($Node.GetRuntimeId())
        if ($runtimeId.Count -eq 0) { throw "precondition_failed" }
        $identity = $runtimeId -join "."
        if (-not $identities.Add($identity)) { throw "precondition_failed" }
        $current = $Node.Current
        $value = Read-OrcaGuardValue $Node
        $text = ""
        if ($Node.GetCurrentPropertyValue([Windows.Automation.AutomationElement]::IsTextPatternAvailableProperty)) {
            $text = $Node.GetCurrentPattern([Windows.Automation.TextPattern]::Pattern).DocumentRange.GetText(2097153)
        }
        $patterns = @($Node.GetSupportedPatterns() | ForEach-Object { $_.ProgrammaticName } | Sort-Object)
        $selected = $null
        if ($Node.GetCurrentPropertyValue([Windows.Automation.AutomationElement]::IsSelectionItemPatternAvailableProperty)) {
            $selected = $Node.GetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern).Current.IsSelected
        }
        $record = [ordered]@{
            parent = $Parent
            runtimeId = $identity
            name = $current.Name
            automationId = $current.AutomationId
            controlType = $current.ControlType.ProgrammaticName
            className = $current.ClassName
            handle = $current.NativeWindowHandle
            enabled = $current.IsEnabled
            offscreen = $current.IsOffscreen
            selected = $selected
            value = $value
            text = $text
            patterns = $patterns
        }
        $serialized = ConvertTo-Json -InputObject $record -Depth 6 -Compress
        $budget.characters += $serialized.Length
        if ($budget.characters -gt 2097152) { throw "precondition_failed" }
        $nodes.Add((Get-OrcaGuardHash $serialized))
        $values[$identity] = Get-OrcaGuardHash $value
        $children = $Node.FindAll([Windows.Automation.TreeScope]::Children, [Windows.Automation.Condition]::TrueCondition)
        for ($childIndex = 0; $childIndex -lt $children.Count; $childIndex++) {
            Visit-OrcaGuardNode $children.Item($childIndex) ($Depth + 1) $identity
        }
    }
    try {
        Visit-OrcaGuardNode $Root 0 ""
        if ($Process -is [Diagnostics.Process]) { $Process.Refresh() }
        $surface = [ordered]@{
            pid = $Process.Id
            handle = [int64]$Process.MainWindowHandle
            title = $Process.MainWindowTitle
            nodes = @($nodes.ToArray())
        }
        [pscustomobject]@{
            fingerprint = Get-OrcaGuardHash (ConvertTo-Json -InputObject $surface -Depth 6 -Compress)
            values = $values
        }
    } catch {
        throw "precondition_failed"
    }
}

function Remove-OrcaExpiredGuards {
    $now = [DateTime]::UtcNow
    foreach ($id in @($script:OrcaSnapshotGuards.Keys)) {
        if (($now - $script:OrcaSnapshotGuards[$id].createdAt).TotalMilliseconds -gt $script:OrcaGuardTtlMilliseconds) {
            $script:OrcaSnapshotGuards.Remove($id)
        }
    }
    while ($script:OrcaSnapshotGuards.Count -gt $script:OrcaGuardCapacity) {
        $script:OrcaSnapshotGuards.Remove(@($script:OrcaSnapshotGuards.Keys)[0])
    }
}

function Save-OrcaSnapshotGuard($Snapshot, $Before, $After, [string]$Scope = "default") {
    if ($null -eq $Before -or $null -eq $After -or $Snapshot.truncation.truncated -or $Before.fingerprint -cne $After.fingerprint) { return }
    $targets = @{}
    foreach ($record in $Snapshot.elements) {
        $identity = $record.runtimeId -join "."
        if (-not $After.values.ContainsKey($identity) -or (Get-OrcaGuardHash ([string]$record.value)) -cne $After.values[$identity]) { return }
        $targets[[string]$record.index] = [pscustomobject]@{
            runtimeId = @($record.runtimeId)
            valueHash = $After.values[$identity]
        }
    }
    $script:OrcaSnapshotGuards[$Snapshot.snapshotId] = [pscustomobject]@{
        scope = $Scope
        createdAt = [DateTime]::UtcNow
        pid = $Snapshot.app.pid
        windowId = $Snapshot.windowId
        fingerprint = $After.fingerprint
        targets = $targets
    }
    Remove-OrcaExpiredGuards
}

function Assert-OrcaSnapshotGuard($Operation, $Process, $Root) {
    try {
        Remove-OrcaExpiredGuards
        $id = $Operation.if_snapshot_id
        if ($id -isnot [string] -or [string]::IsNullOrWhiteSpace($id)) { throw "precondition_failed" }
        if ($id.Length -gt 256) { throw "precondition_failed" }
        $prior = $script:OrcaSnapshotGuards[$id]
        $scope = if ($null -eq $Operation.guard_scope) { "default" } else { [string]$Operation.guard_scope }
        if ($null -ne $prior -and $prior.scope -cne $scope) { throw "precondition_failed" }
        if ($null -eq $prior -or $prior.pid -ne $Process.Id -or $prior.windowId -ne [int64]$Process.MainWindowHandle) { throw "precondition_failed" }
        if ($Operation.tool -notin @("click", "perform_secondary_action", "set_value") -or $Operation.restoreWindow -or $Operation.physical -or $null -eq $Operation.element) { throw "precondition_failed" }
        if ($null -ne $Operation.x -or $null -ne $Operation.y -or $null -ne $Operation.windowBounds) { throw "precondition_failed" }
        $target = $prior.targets[[string]$Operation.element.index]
        if ($null -eq $target -or -not (Test-OrcaSameRuntimeId $target.runtimeId @($Operation.element.runtimeId))) { throw "precondition_failed" }
        if ($target.valueHash -cne (Get-OrcaGuardHash ([string]$Operation.element.value))) { throw "precondition_failed" }
        $fresh = Find-OrcaElement $Root $Operation.element
        if ($null -eq $fresh -or -not (Test-OrcaSameRuntimeId $target.runtimeId @($fresh.GetRuntimeId()))) { throw "precondition_failed" }
        if (-not $fresh.Current.IsEnabled -or $fresh.Current.IsPassword) { throw "precondition_failed" }
        $pattern = $null
        $namedAction = $null
        if ($Operation.tool -eq "set_value") {
            if ($Operation.value -isnot [string] -or $target.valueHash -cne (Get-OrcaGuardHash (Read-OrcaGuardValue $fresh))) { throw "precondition_failed" }
            $pattern = $fresh.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern)
            if ($pattern.Current.IsReadOnly) { throw "precondition_failed" }
        }
        if ($Operation.tool -eq "perform_secondary_action" -and $Operation.action -notin @("invoke", "select", "toggle")) { throw "precondition_failed" }
        if ($Operation.tool -eq "perform_secondary_action") { $namedAction = $Operation.action.ToLowerInvariant() }
        if ($Operation.tool -eq "click") {
            [void](Get-OrcaPositiveInteger $Operation.click_count "click_count")
            if ($Operation.mouse_button -and $Operation.mouse_button -notin @("left", "right", "middle")) { throw "precondition_failed" }
            [void](Get-OrcaClickModifierVirtualKeys $Operation.modifiers)
            $semantic = -not $Operation.modifiers -and $Operation.mouse_button -notin @("right", "middle") -and (Get-OrcaPositiveInteger $Operation.click_count "click_count") -eq 1
            if (-not $semantic) { throw "precondition_failed" }
            if ($semantic) {
                $supported = @($fresh.GetSupportedPatterns() | ForEach-Object { $_.ProgrammaticName })
                foreach ($candidate in @("Invoke", "SelectionItem", "Toggle")) {
                    if ("$($candidate)PatternIdentifiers.Pattern" -in $supported) {
                        $namedAction = @{ Invoke = "invoke"; SelectionItem = "select"; Toggle = "toggle" }[$candidate]
                        break
                    }
                }
                if ($null -eq $namedAction) { throw "precondition_failed" }
            }
        }
        if ($null -ne $namedAction) {
            $patternId = switch ($namedAction) {
                "invoke" { [Windows.Automation.InvokePattern]::Pattern }
                "select" { [Windows.Automation.SelectionItemPattern]::Pattern }
                "toggle" { [Windows.Automation.TogglePattern]::Pattern }
            }
            $pattern = $fresh.GetCurrentPattern($patternId)
        }
        $current = Read-OrcaGuardState $Process $Root
        if ($prior.fingerprint -cne $current.fingerprint) { throw "precondition_failed" }
        if (-not (Test-OrcaSameRuntimeId $target.runtimeId @($fresh.GetRuntimeId()))) { throw "precondition_failed" }
        if ($Operation.tool -eq "set_value" -and $target.valueHash -cne (Get-OrcaGuardHash (Read-OrcaGuardValue $fresh))) { throw "precondition_failed" }
        return [pscustomobject]@{ element = $fresh; pattern = $pattern; namedAction = $namedAction }
    } catch {
        # Never expose UIA exception text, window titles, labels or draft values.
        throw "precondition_failed"
    }
}

function Invoke-OrcaGuardedEffect($Operation, $Plan) {
    # UIA has no transaction with human input; do not retry a partially failed effect.
    try {
        if ($Operation.tool -eq "set_value") {
            $Plan.pattern.SetValue($Operation.value)
            return [pscustomobject]@{ path = "accessibility"; actionName = "setValue"; fallbackReason = $null }
        }
        if ($null -ne $Plan.namedAction) {
            switch ($Plan.namedAction) {
                "invoke" { $Plan.pattern.Invoke() }
                "select" { $Plan.pattern.Select() }
                "toggle" { $Plan.pattern.Toggle() }
            }
            $name = if ($Operation.tool -eq "click") { "primaryAction" } else { $Plan.namedAction }
            return [pscustomobject]@{ path = "accessibility"; actionName = $name; fallbackReason = $null }
        }
        throw "guarded action has no semantic effect"
    } catch {
        throw "guarded action effect failed; outcome unknown"
    }
}
