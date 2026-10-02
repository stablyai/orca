/**
 * The Windows half of the pinned-Node runtime store: `runtimes\node-<sha>\node.exe` with a
 * `.verified` marker, beside the relay version directories (design D2, D5 "Windows").
 *
 * Each phase is ONE PowerShell invocation through `powerShellCommand`, which adds no new
 * `-EncodedCommand` site, spells no `-ExecutionPolicy` and compiles nothing (`Add-Type`); see
 * docs/reference/windows-edr-posture.md. node.exe keeps upstream's name and layout.
 */
import {
  pinnedNodeRuntimeAsset,
  NODE_RUNTIME_PIN,
  nodeRuntimeExecutablePath
} from '../../shared/node-runtime-pin'
import type { NodeRuntimeTarget } from '../../shared/node-runtime-pin'
import { ORCAD_NODE_RUNTIME_WINDOWS_EXECUTABLE } from '../../shared/orcad-artifacts'
import {
  REMOTE_NODE_RUNTIME_EXIT_PREFIX,
  REMOTE_NODE_RUNTIME_MISSING,
  REMOTE_NODE_RUNTIME_READY,
  REMOTE_NODE_RUNTIME_SECURITY_MODIFIED,
  REMOTE_NODE_RUNTIME_SELFTEST_FAILED,
  REMOTE_NODE_RUNTIME_VERIFIED_MARKER
} from './orcad-remote-node-runtime-report'
import { powerShellCommand, powerShellLiteral } from './ssh-remote-powershell'

/** Promotion may fall back to Expand-Archive, which unpacks the whole ~30 MiB zip. */
export const WINDOWS_NODE_RUNTIME_PROMOTE_TIMEOUT_MS = 300_000

function windowsPath(...segments: string[]): string {
  return segments
    .map((segment, index) => (index === 0 ? segment.replace(/\/+$/, '') : segment))
    .join('/')
}

// Why no `$ErrorActionPreference = 'Stop'`: under Windows PowerShell 5.1 it turns any stderr
// line from a native command (tar.exe, node.exe) into a terminating error.
function prelude(): string[] {
  return [
    // Why: PS 5.1 progress records slow Expand-Archive badly and leak CLIXML into stdout.
    "$ProgressPreference = 'SilentlyContinue'",
    'function Get-OrcaSha256([string]$p) { if (Test-Path -LiteralPath $p -PathType Leaf) { (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant() } else { "" } }'
  ]
}

function runtimeVariables(runtimeDir: string): string[] {
  return [
    `$runtimeDir = ${powerShellLiteral(runtimeDir)}`,
    `$exe = ${powerShellLiteral(windowsPath(runtimeDir, ORCAD_NODE_RUNTIME_WINDOWS_EXECUTABLE))}`,
    `$verified = ${powerShellLiteral(windowsPath(runtimeDir, REMOTE_NODE_RUNTIME_VERIFIED_MARKER))}`
  ]
}

/**
 * Ready only when node.exe hashes to the pin under its marker. When it is not, and a stage is
 * named, the same invocation creates the upload stage so the install costs no extra spawn.
 */
export function windowsNodeRuntimeProbeCommand(
  runtimeDir: string,
  target: NodeRuntimeTarget,
  stageDir?: string
): string {
  return powerShellCommand(
    [
      ...prelude(),
      ...runtimeVariables(runtimeDir),
      `if ((Get-OrcaSha256 $exe) -eq ${powerShellLiteral(pinnedNodeRuntimeAsset(target).executableSha256)}) {`,
      `if (Test-Path -LiteralPath $verified -PathType Leaf) { Write-Output ${powerShellLiteral(REMOTE_NODE_RUNTIME_READY)}; exit 0 }`,
      // Why adopt: earlier Windows vault readers left the pinned node.exe here with no marker.
      // Running it is the same check promotion makes before it writes one.
      `try { $adoptOut = ((& $exe --version 2>&1) | ForEach-Object { "$_" }) -join ''; if (($LASTEXITCODE -eq 0) -and ($adoptOut.Trim() -eq ${powerShellLiteral(`v${NODE_RUNTIME_PIN.version}`)})) { [IO.File]::WriteAllText($verified, ''); Write-Output ${powerShellLiteral(REMOTE_NODE_RUNTIME_READY)}; exit 0 } } catch { }`,
      '}',
      ...(stageDir
        ? [
            `$null = New-Item -ItemType Directory -Force -Path ${powerShellLiteral(stageDir)} -ErrorAction Stop`
          ]
        : []),
      `Write-Output ${powerShellLiteral(REMOTE_NODE_RUNTIME_MISSING)}`
    ].join('\n')
  )
}

/** Cheap warm-path check: a published runtime has its marker and node.exe; no re-hash. */
export function windowsNodeRuntimePresentCommand(runtimeDir: string): string {
  return powerShellCommand(
    [
      ...runtimeVariables(runtimeDir),
      `if ((Test-Path -LiteralPath $verified -PathType Leaf) -and (Test-Path -LiteralPath $exe -PathType Leaf)) { Write-Output ${powerShellLiteral(REMOTE_NODE_RUNTIME_READY)} } else { Write-Output ${powerShellLiteral(REMOTE_NODE_RUNTIME_MISSING)} }`
    ].join('\n')
  )
}

/**
 * Verify the uploaded zip, extract node.exe (tar.exe, else Expand-Archive), verify it, run it,
 * then publish the runtime directory with one directory rename. Bytes that were verified and
 * then change or vanish are reported as security software, never retried as a transfer fault.
 */
export function windowsNodeRuntimePromoteCommand(args: {
  stageDir: string
  archive: string
  runtimeDir: string
  target: NodeRuntimeTarget
}): string {
  const asset = pinnedNodeRuntimeAsset(args.target)
  const member = nodeRuntimeExecutablePath(args.target, asset.archive)
  const modified = (what: string): string =>
    `Write-Output ${powerShellLiteral(`${REMOTE_NODE_RUNTIME_SECURITY_MODIFIED} ${what}`)}`
  return powerShellCommand(
    [
      ...prelude(),
      ...runtimeVariables(args.runtimeDir),
      `$stage = ${powerShellLiteral(args.stageDir)}`,
      `$archive = ${powerShellLiteral(windowsPath(args.stageDir, args.archive))}`,
      `$extracted = ${powerShellLiteral(windowsPath(args.stageDir, ...member.split('/')))}`,
      `$candidate = ${powerShellLiteral(windowsPath(args.stageDir, 'promote'))}`,
      `$pin = ${powerShellLiteral(asset.executableSha256)}`,
      // Why a function: `return` leaves it and the stage cleanup below still runs, which `exit` would skip.
      '$script:code = 0',
      'function Invoke-OrcaPromote {',
      `$archiveHash = Get-OrcaSha256 $archive`,
      `if ($archiveHash -eq '') { Write-Output 'ORCA_NODE_RUNTIME_ARCHIVE_MISSING'; $script:code = 1; return }`,
      `if ($archiveHash -ne ${powerShellLiteral(asset.archiveSha256)}) { ${modified('the uploaded archive changed after it was written')}; return }`,
      // Why the System32 path: a Git or MSYS tar.exe earlier on PATH cannot read a zip.
      "$tar = Join-Path $env:SystemRoot 'System32\\tar.exe'",
      '$extractedBy = $null',
      'if (Test-Path -LiteralPath $tar -PathType Leaf) {',
      `$null = & $tar -xf $archive -C $stage ${powerShellLiteral(member)} 2>&1`,
      "if ($LASTEXITCODE -eq 0) { $extractedBy = 'tar' }",
      '}',
      'if ($null -eq $extractedBy) {',
      "try { Expand-Archive -LiteralPath $archive -DestinationPath $stage -Force -ErrorAction Stop; $extractedBy = 'Expand-Archive' } catch { Write-Output ('ORCA_NODE_RUNTIME_EXTRACT_FAILED ' + $_.Exception.Message); $script:code = 1; return }",
      '}',
      `if (-not (Test-Path -LiteralPath $extracted -PathType Leaf)) { ${modified('node.exe vanished after extraction')}; return }`,
      `if ((Get-OrcaSha256 $extracted) -ne $pin) { ${modified('node.exe changed after extraction')}; return }`,
      // Why run it: executing is the only reliable check for application control and AV blocks.
      "$runOut = ''; $runStatus = $null",
      'try { $runOut = ((& $extracted --version 2>&1) | ForEach-Object { "$_" }) -join "`n"; $runStatus = $LASTEXITCODE } catch { $runStatus = -1; $runOut = $_.Exception.Message }',
      `if (($runStatus -ne 0) -or ($runOut.Trim() -ne ${powerShellLiteral(`v${NODE_RUNTIME_PIN.version}`)})) {`,
      `Write-Output ${powerShellLiteral(REMOTE_NODE_RUNTIME_SELFTEST_FAILED)}`,
      `Write-Output (${powerShellLiteral(REMOTE_NODE_RUNTIME_EXIT_PREFIX)} + $runStatus)`,
      'Write-Output ($runOut.Substring(0, [Math]::Min(4000, $runOut.Length)))',
      'return',
      '}',
      `if ((Get-OrcaSha256 $extracted) -ne $pin) { ${modified('node.exe changed after it ran')}; return }`,
      '$null = New-Item -ItemType Directory -Force -Path $candidate -ErrorAction Stop',
      `Move-Item -LiteralPath $extracted -Destination (Join-Path $candidate ${powerShellLiteral(ORCAD_NODE_RUNTIME_WINDOWS_EXECUTABLE)}) -ErrorAction Stop`,
      `[IO.File]::WriteAllText((Join-Path $candidate ${powerShellLiteral(REMOTE_NODE_RUNTIME_VERIFIED_MARKER)}), '')`,
      '$null = New-Item -ItemType Directory -Force -Path (Split-Path -Parent $runtimeDir) -ErrorAction Stop',
      'if ((Test-Path -LiteralPath $runtimeDir) -and ((Get-OrcaSha256 $exe) -ne $pin)) { Remove-Item -LiteralPath $runtimeDir -Recurse -Force -ErrorAction Stop }',
      // Why Directory.Move: it refuses an existing target, where Move-Item would nest inside it.
      // Why retry: an on-access scan of the new node.exe can briefly hold the directory.
      'for ($attempt = 1; ($attempt -le 5) -and -not (Test-Path -LiteralPath $runtimeDir); $attempt++) { try { [IO.Directory]::Move($candidate, $runtimeDir) } catch { Start-Sleep -Milliseconds 400 } }',
      "if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'The pinned Node runtime directory could not be published' }",
      "if (-not (Test-Path -LiteralPath $verified -PathType Leaf)) { [IO.File]::WriteAllText($verified, '') }",
      `if ((Get-OrcaSha256 $exe) -ne $pin) { Remove-Item -LiteralPath $verified -Force -ErrorAction SilentlyContinue; ${modified('node.exe changed after it was published')}; return }`,
      `Write-Output ('extracted-by ' + $extractedBy)`,
      `Write-Output ${powerShellLiteral(REMOTE_NODE_RUNTIME_READY)}`,
      '}',
      'try { Invoke-OrcaPromote } catch { [Console]::Error.WriteLine($_.Exception.Message); $script:code = 1 }',
      'Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue',
      'exit $script:code'
    ].join('\n')
  )
}

export function windowsNodeRuntimeStageCleanupCommand(stageDir: string): string {
  return powerShellCommand(
    `Remove-Item -LiteralPath ${powerShellLiteral(stageDir)} -Recurse -Force -ErrorAction SilentlyContinue`
  )
}
