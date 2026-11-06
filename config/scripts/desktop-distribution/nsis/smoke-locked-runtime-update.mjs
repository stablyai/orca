import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { runProcessSync } from '@orca/process-host'

assert.equal(process.platform, 'win32', 'This smoke check requires Windows and an NSIS compiler')
const compiler = process.argv[2]
assert.ok(compiler, 'Pass the path to makensis.exe')
const scratch = mkdtempSync(join(tmpdir(), 'Orca runtime lock '))
const header = resolve(import.meta.dirname, '../../../nsis/orca-process-check.nsh')
const includes = resolve(
  import.meta.dirname,
  '../../../../node_modules/app-builder-lib/templates/nsis/include'
)
const env = { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' }

function run(program, args) {
  return runProcessSync({ program, args, env, timeoutMs: 60_000 })
}

try {
  const installer = join(scratch, 'installer.exe')
  const source = join(scratch, 'installer.nsi')
  const installerSource = String.raw`Unicode true
RequestExecutionLevel user
SilentInstall silent
OutFile "${installer}"
!include "LogicLib.nsh"
!addincludedir "${includes}"
!define APP_EXECUTABLE_FILENAME "Orca.exe"
!include "${header}"
Var PowerShellPath
!macro _CHECK_APP_RUNNING
!macroend
LangString appCannotBeClosed 1033 "Orca executable is still in use"
Section
  StrCpy $INSTDIR "$EXEDIR\target"
  StrCpy $PowerShellPath "$SYSDIR\orca-probe-unavailable.exe"
  !insertmacro customCheckAppRunning
  FileOpen $0 "$INSTDIR\Orca.exe" w
  FileWrite $0 "new executable"
  FileClose $0
  FileOpen $0 "$INSTDIR\runtime.dat" w
  FileWrite $0 "new runtime"
  FileClose $0
SectionEnd
`
  writeFileSync(source, `\uFEFF${installerSource}`)
  const compiled = run(compiler, ['/V2', source])
  assert.equal(compiled.code, 0, compiled.stdout + compiled.stderr)
  const target = join(scratch, 'target')
  mkdirSync(target)
  const executable = join(target, 'Orca.exe')
  const runtime = join(target, 'runtime.dat')
  const lockScript = join(scratch, 'run-locked.ps1')
  writeFileSync(
    lockScript,
    `param([string]$Installer, [string]$Target)
$ErrorActionPreference = 'Stop'
$handle = [System.IO.File]::Open($Target, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
try {
  $child = Start-Process -FilePath $Installer -ArgumentList '/S' -Wait -PassThru -WindowStyle Hidden
  exit $child.ExitCode
} finally { $handle.Dispose() }
`
  )
  writeFileSync(executable, 'old executable')
  writeFileSync(runtime, 'old runtime')
  const locked = run(
    join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      lockScript,
      '-Installer',
      installer,
      '-Target',
      executable
    ]
  )
  assert.equal(locked.code, 2, locked.stdout + locked.stderr)
  assert.equal(readFileSync(executable, 'utf8'), 'old executable')
  assert.equal(readFileSync(runtime, 'utf8'), 'old runtime')
  const unlocked = run(installer, ['/S'])
  assert.equal(unlocked.code, 0, unlocked.stdout + unlocked.stderr)
  assert.equal(readFileSync(executable, 'utf8'), 'new executable')
  assert.equal(readFileSync(runtime, 'utf8'), 'new runtime')
  rmSync(executable)
  const fresh = run(installer, ['/S'])
  assert.equal(fresh.code, 0, fresh.stdout + fresh.stderr)
  assert.equal(readFileSync(executable, 'utf8'), 'new executable')
  console.log(
    'NSIS runtime write check passed: locked update unchanged, unlocked update, fresh install'
  )
} finally {
  assert.equal(dirname(scratch), tmpdir())
  rmSync(scratch, { recursive: true, force: true })
}
