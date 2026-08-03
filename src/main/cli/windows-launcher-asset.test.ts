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
})
