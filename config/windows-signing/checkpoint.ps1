$ErrorActionPreference = 'Stop'
$stage = $env:STAGE
if ($stage -notin @('inner', 'installer')) { throw 'Invalid signing stage.' }
if ($env:GITHUB_RUN_ID -notmatch '^\d+$') { throw 'Invalid run identity.' }
$sourceSha = (git rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve the built commit.' }
$directory = Join-Path $env:GITHUB_WORKSPACE 'signing-checkpoint'

if ($env:MODE -eq 'save') {
  if ($env:GITHUB_RUN_ATTEMPT -ne '1') { throw 'Never create a signing checkpoint on a rerun.' }
  if ($env:REQUEST_ID -notmatch '^[a-fA-F0-9]{8}(-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$') { throw 'Invalid signing request ID.' }
  New-Item -ItemType Directory -Force $directory | Out-Null
  $cache = Join-Path $env:GITHUB_WORKSPACE 'signing-nsis-cache'
  New-Item -ItemType Directory -Force $cache | Out-Null
  foreach ($name in @('nsis', 'nsis-resources')) {
    $from = Join-Path "$env:LOCALAPPDATA/electron-builder/Cache" $name
    if (Test-Path -LiteralPath $from) {
      Copy-Item -LiteralPath $from -Destination $cache -Recurse -Force
    }
  }
  if (-not (Test-Path -LiteralPath "$cache/nsis")) { throw 'The NSIS tool cache must be checkpointed with the build.' }
  tar -czf "$directory/checkpoint.tar.gz" dist/win-unpacked dist/orca-windows-setup.exe dist/latest.yml inner-signing-list.txt signing-nsis-cache
  if ($LASTEXITCODE -ne 0) { throw 'Could not archive the exact Windows build.' }
  $manifest = @{
    version = 1; repository = $env:GITHUB_REPOSITORY; runId = $env:GITHUB_RUN_ID
    submittedAttempt = 1; workflowSha = $env:GITHUB_WORKFLOW_SHA; sourceSha = $sourceSha
    tag = $env:TAG; stage = $stage; policy = $env:SIGNING_POLICY; requestId = $env:REQUEST_ID
    sha256 = (Get-FileHash -LiteralPath "$directory/checkpoint.tar.gz" -Algorithm SHA256).Hash.ToLowerInvariant()
  }
  $manifest | ConvertTo-Json | Set-Content -LiteralPath "$directory/checkpoint.json"
} elseif ($env:MODE -eq 'restore') {
  $prefix = "orca-signing-$stage-$env:GITHUB_RUN_ID-1-"
  $inventoryText = gh api "repos/$env:GITHUB_REPOSITORY/actions/runs/$env:GITHUB_RUN_ID/artifacts?per_page=100"
  if ($LASTEXITCODE -ne 0) { throw 'Cannot list original signing checkpoints.' }
  $inventory = $inventoryText | ConvertFrom-Json
  if ($inventory.total_count -gt 100) { throw 'Signing checkpoint inventory exceeds supported bound.' }
  $artifacts = @($inventory.artifacts | Where-Object { $_.name.StartsWith($prefix) })
  if ($artifacts.Count -ne 1) { throw 'Exactly one original signing checkpoint is required. Never resubmit on reruns; use a fresh release dispatch if the checkpoint is missing.' }
  $artifact = $artifacts[0]
  if ($artifact.expired -or "$($artifact.workflow_run.id)" -ne $env:GITHUB_RUN_ID -or $artifact.workflow_run.head_sha -ne $env:GITHUB_SHA) { throw 'Signing checkpoint expired or has a different origin.' }
  if (Test-Path -LiteralPath $directory) { Remove-Item -LiteralPath $directory -Recurse -Force }
  gh run download $env:GITHUB_RUN_ID --repo $env:GITHUB_REPOSITORY --name $artifact.name --dir $directory
  if ($LASTEXITCODE -ne 0) { throw 'Cannot download the original signing checkpoint.' }
  $manifest = Get-Content -LiteralPath "$directory/checkpoint.json" -Raw | ConvertFrom-Json
  if ($manifest.version -ne 1 -or $manifest.repository -ne $env:GITHUB_REPOSITORY -or "$($manifest.runId)" -ne $env:GITHUB_RUN_ID -or $manifest.submittedAttempt -ne 1 -or $manifest.workflowSha -ne $env:GITHUB_WORKFLOW_SHA -or $manifest.sourceSha -ne $sourceSha -or $manifest.tag -ne $env:TAG -or $manifest.stage -ne $stage -or $manifest.policy -ne $env:SIGNING_POLICY -or "$prefix$($manifest.requestId)" -ne $artifact.name) { throw 'Signing checkpoint identity mismatch.' }
  $actual = (Get-FileHash -LiteralPath "$directory/checkpoint.tar.gz" -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $manifest.sha256) { throw 'Signing checkpoint SHA-256 mismatch.' }
  $entries = @(tar -tzf "$directory/checkpoint.tar.gz")
  if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect checkpoint archive.' }
  foreach ($entry in $entries) {
    if ($entry -match '(^[/\\]|^[A-Za-z]:|(^|[/\\])\.\.([/\\]|$))' -or $entry -notmatch '^(dist/(win-unpacked(/|$)|orca-windows-setup\.exe$|latest\.yml$)|inner-signing-list\.txt$|signing-nsis-cache(/|$))') { throw "Unexpected checkpoint entry: $entry" }
  }
  $types = @(tar -tvzf "$directory/checkpoint.tar.gz")
  if ($LASTEXITCODE -ne 0 -or @($types | Where-Object { $_ -notmatch '^[d-]' }).Count -gt 0) { throw 'Checkpoint links and special files are not supported.' }
  tar -xzf "$directory/checkpoint.tar.gz" -C $env:GITHUB_WORKSPACE
  if ($LASTEXITCODE -ne 0) { throw 'Could not restore Windows build checkpoint.' }
  $cacheRoot = "$env:LOCALAPPDATA/electron-builder/Cache"
  New-Item -ItemType Directory -Force $cacheRoot | Out-Null
  foreach ($name in @('nsis', 'nsis-resources')) {
    $from = Join-Path "$env:GITHUB_WORKSPACE/signing-nsis-cache" $name
    $to = Join-Path $cacheRoot $name
    if (Test-Path -LiteralPath $from) {
      if (Test-Path -LiteralPath $to) { Remove-Item -LiteralPath $to -Recurse -Force }
      Copy-Item -LiteralPath $from -Destination $to -Recurse -Force
    }
  }
  "SIGNPATH_REQUEST_ID=$($manifest.requestId)" >> $env:GITHUB_ENV
  "SIGNING_CHECKPOINT_SOURCE_SHA=$sourceSha" >> $env:GITHUB_ENV
} else { throw 'Invalid checkpoint operation.' }
