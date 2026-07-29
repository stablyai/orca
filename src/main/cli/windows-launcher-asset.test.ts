import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('packaged Windows CLI launcher asset', () => {
  it('keeps the batch compatibility shim behind the newline-safe native launcher', () => {
    const launcherPath = join(process.cwd(), 'resources', 'win32', 'bin', 'orca.cmd')
    const launcher = readFileSync(launcherPath, 'utf8')

    expect(launcher).toContain('set "LAUNCHER=%SCRIPT_DIR%orca.exe"')
    expect(launcher).toContain('orca.cmd cannot safely forward orchestration message bodies')
    expect(launcher).not.toContain('"%ELECTRON%" "%CLI%" %*')
  })

  it('marks the packaged child and propagates its exact exit status', () => {
    const sourcePath = join(process.cwd(), 'native', 'windows-cli-launcher', 'OrcaCliLauncher.cs')
    const source = readFileSync(sourcePath, 'utf8')

    expect(source).toContain(
      'startInfo.EnvironmentVariables["ORCA_WINDOWS_PACKAGED_CLI_LAUNCHER"] = "1";'
    )
    expect(source).toContain('Environment.GetEnvironmentVariable("ORCA_CLI_COMMAND") == "orca-ide"')
    expect(source).toContain('? "orca-ide"')
    expect(source).toContain(': "orca";')
    expect(source).toContain('child.WaitForExit();')
    expect(source).toContain('return child.ExitCode;')
  })

  it('requires exact updater process and executable release proof', () => {
    const includePath = join(process.cwd(), 'config', 'nsis', 'daemon-host-uninstall.nsh')
    const source = readFileSync(includePath, 'utf8')

    expect(source).toContain('!macro customCheckAppRunning')
    expect(source).toContain('!include "getProcessInfo.nsh"')
    expect(source).toContain('Var pid')
    expect(source).toContain('[String]::Equals')
    expect(source).toContain('"$INSTDIR\\Orca.exe" "$INSTDIR\\resources\\bin\\orca.exe"')
    expect(source).toContain('CreationDate=[string]$$parent.CreationDate')
    expect(source).toContain("'ProcessId=' + $$proof.ProcessId")
    expect(source).toContain('[IO.FileShare]::None')
    expect(source).toContain('$$released=$$false')
    expect(source).toContain('$$released=$$true')
    expect(source).not.toMatch(/(?<!\$)(?:\$\$)*\$(?:false|true)\b/)
    expect(source).toContain(
      '  ${else}\n    !insertmacro IS_POWERSHELL_AVAILABLE\n    !insertmacro _CHECK_APP_RUNNING\n  ${endIf}'
    )
    expect(source).toContain('SetErrorLevel 2')
    expect(source).toContain('Quit')
    expect(source).not.toContain('taskkill /IM Orca.exe')
  })
})
