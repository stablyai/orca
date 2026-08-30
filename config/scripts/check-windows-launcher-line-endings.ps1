# Behavioural check for the shipped Windows CLI shim, resources/win32/bin/orca.cmd.
#
# The static half lives in check-line-ending-policy.mjs, which asserts the pin still
# resolves. This half asserts the thing the pin exists for: that the shim, in exactly
# the encoding CI checked out, still runs under a real cmd.exe. Nothing else executes
# it — smoke-packaged-cli.mjs resolves the packaged CLI to resources/bin/orca.exe on
# win32, so the .cmd beside it has never been run by any test.
#
# It also measures the LF encoding and reports the outcome. That result is a finding,
# not a policy violation, so it never fails the job on its own: the pin means LF is
# not what ships either way, and a green run must not be read as "LF was fine".
#
# Contract: this script fails or reports explicitly. There is no path on which a
# missing fixture, a broken stub, or an unexecuted arm reads as a pass.
#
# Why PowerShell and not a config/scripts/*.mjs: driving a .cmd file from Node would
# mean child_process with the .cmd argument-encoding hazard AGENTS.md forbids, and the
# repo's runProcess wrapper is TypeScript under src/. A pwsh step also has no MSYS
# layer, so the bare `/c` switch survives (docs/reference/windows-setup-shell.md).

$ErrorActionPreference = 'Stop'
# Every native call below merges its own streams inside cmd, so PowerShell should never
# see stderr — but on hosts where this preference is on, one stray line would abort the
# run mid-arm and read as a harness crash rather than a result.
if (Test-Path variable:PSNativeCommandUseErrorActionPreference) {
  $PSNativeCommandUseErrorActionPreference = $false
}

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Relative = 'resources/win32/bin/orca.cmd'
$Source = Join-Path $RepoRoot 'resources\win32\bin\orca.cmd'

function Fail($message) {
  Write-Host "::error::$message"
  exit 1
}

function Get-CrCount([byte[]]$bytes) {
  $count = 0
  foreach ($byte in $bytes) {
    if ($byte -eq 13) { $count++ }
  }
  return $count
}

# `/s /c` so cmd strips exactly the outer quotes and takes the rest literally, instead
# of applying its conditional quote-stripping rule. The `2>&1` is inside the command
# line so cmd merges the streams itself; letting PowerShell merge a native command's
# stderr turns it into an ErrorRecord under some hosts and aborts the run.
function Invoke-Shim([string]$directory, [string]$arguments) {
  Push-Location $directory
  try {
    $output = & cmd.exe /s /c "orca.cmd $arguments 2>&1"
    return [pscustomobject]@{ Code = $LASTEXITCODE; Output = ($output -join "`n") }
  } finally {
    Pop-Location
  }
}

if (-not (Test-Path $Source)) {
  Fail "PROBE CANNOT RUN: $Relative is absent. Not a pass."
}

# --- What the checkout produced ------------------------------------------------
# Read through git rather than off disk: `i/` is the stored blob and `w/` is the
# working tree, which is the whole distinction the pin turns on.
$eol = (& git -C $RepoRoot ls-files --eol -- $Relative) -join ''
if ($LASTEXITCODE -ne 0 -or -not $eol) {
  Fail "PROBE CANNOT RUN: git ls-files --eol returned nothing for $Relative. Not a pass."
}
Write-Host "checkout state: $eol"

if ($eol -notmatch '(^|\s)i/lf(\s|$)') {
  Fail "The committed blob is not LF ($eol). eol=crlf converts on checkout, so a CRLF blob ships CRLF on macOS and Linux too."
}
if ($eol -notmatch '(^|\s)w/crlf(\s|$)') {
  Fail "This runner checked $Relative out as LF, not CRLF ($eol). v1.4.192 shipped it as CRLF; the /resources/win32/bin/orca.cmd text eol=crlf pin is missing or was overridden."
}

$shipped = [IO.File]::ReadAllBytes($Source)
Write-Host ("as checked out: {0} bytes, {1} CR" -f $shipped.Length, (Get-CrCount $shipped))

# --- The stub the shim shells out to -------------------------------------------
# orca.cmd exits 1 at its `if not exist "%LAUNCHER%"` block before reaching any of
# the code under test, so a real orca.exe has to be beside it or both arms measure
# nothing. A copy of cmd.exe is the stub: `orca.cmd /c exit 7` falls through to
# `"%LAUNCHER%" /c exit 7`, making 7 a sentinel that only a shim which parsed to its
# last line can produce. No compiler, and nothing to skip on.
if (-not $env:ComSpec) {
  Fail 'PROBE CANNOT RUN: %ComSpec% is unset, so there is no cmd.exe to test against. Not a pass.'
}
$scratch = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { $env:TEMP }
if (-not $scratch) {
  Fail 'PROBE CANNOT RUN: neither RUNNER_TEMP nor TEMP is set. Not a pass.'
}
$work = Join-Path $scratch 'orca-shim-eol'
Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $work | Out-Null
$stub = Join-Path $work 'orca.exe'
Copy-Item $env:ComSpec $stub -Force

# Validate the sentinel itself, or a stub that cannot return 7 would read as a shim
# that failed to parse.
& $stub /s /c "exit 7" | Out-Null
if ($LASTEXITCODE -ne 7) {
  Fail "PROBE CANNOT RUN: the stub launcher returned $LASTEXITCODE, not the 7 sentinel. Not a pass."
}

$arms = @{}
foreach ($encoding in @('shipped', 'lf')) {
  $directory = Join-Path $work $encoding
  New-Item -ItemType Directory -Force -Path $directory | Out-Null
  Copy-Item $stub $directory -Force

  # The `shipped` arm is the checked-out bytes verbatim — no rewrite, so it measures
  # what this commit actually produces. The `lf` arm strips the CRs from those same
  # bytes, which is what the blanket rule alone would have written.
  $target = Join-Path $directory 'orca.cmd'
  if ($encoding -eq 'shipped') {
    [IO.File]::WriteAllBytes($target, $shipped)
  } else {
    [IO.File]::WriteAllBytes($target, [byte[]]($shipped | Where-Object { $_ -ne 13 }))
  }
  $written = [IO.File]::ReadAllBytes($target)
  Write-Host ("[{0}] {1} bytes, {2} CR" -f $encoding, $written.Length, (Get-CrCount $written))

  # Arm 1, the guard path: `goto :unsafe_body` must fire. Label seeking is the one
  # batch construct with a history of misbehaving without CRLF, so this is the arm
  # the encoding question actually rides on.
  $guard = Invoke-Shim $directory 'orchestration send --body x'
  # Arm 2, the fall-through: no goto taken, the shim reaches `"%LAUNCHER%" %*` and
  # propagates its status. Proves the file parses end to end.
  $through = Invoke-Shim $directory '/c exit 7'

  $guardOk = ($guard.Code -eq 2) -and
    ($guard.Output -match 'cannot safely forward orchestration message bodies')
  $throughOk = $through.Code -eq 7
  Write-Host ("[{0}] guard exit={1} want 2, message {2} | fall-through exit={3} want 7" -f
    $encoding, $guard.Code, $(if ($guardOk) { 'present' } else { 'MISSING' }), $through.Code)
  Write-Host ("[{0}] guard output: {1}" -f $encoding, $guard.Output)

  $arms[$encoding] = [pscustomobject]@{ GuardOk = $guardOk; ThroughOk = $throughOk }
}

# --- Verdict -------------------------------------------------------------------
if (-not ($arms['shipped'].GuardOk -and $arms['shipped'].ThroughOk)) {
  Fail "The Windows CLI shim does not behave in the encoding this commit ships. Guard path must exit 2 with its own message and the fall-through must propagate 7."
}

if ($arms['lf'].GuardOk -and $arms['lf'].ThroughOk) {
  Write-Host 'FINDING: LF is safe for this shim on this image — both arms matched the shipped encoding. The CRLF pin is a consistency choice (it reproduces the shipped bytes), not a correctness one.'
} else {
  Write-Host 'FINDING: LF breaks this shim on this image, while the shipped encoding passes both arms. The CRLF pin is load-bearing.'
}

Write-Host 'Windows CLI shim OK in the encoding this commit ships.'
exit 0
