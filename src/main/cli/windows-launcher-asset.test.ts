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
    const sourcePath = join(process.cwd(), 'native', 'windows-cli-launcher', 'src', 'main.rs')
    const source = readFileSync(sourcePath, 'utf8')

    // Why: the marker and command name must ride the launcher's own environment, never an
    // explicit child map, whose case-insensitive keys collapse PATH and Path (stablyai/orca#12046).
    expect(source).toContain('env::set_var("ORCA_WINDOWS_PACKAGED_CLI_LAUNCHER", "1")')
    expect(source).toContain('env::var("ORCA_CLI_COMMAND")')
    expect(source).toContain('if requested_command == "orca-ide"')
    expect(source).toContain('command.status()')
    expect(source).toContain('exit(status.code().unwrap_or(1))')
  })

  it('clears an inherited Crashpad pipe before launching Electron-as-Node', () => {
    const sourcePath = join(process.cwd(), 'native', 'windows-cli-launcher', 'src', 'main.rs')
    const source = readFileSync(sourcePath, 'utf8')

    const cleanupIndex = source.indexOf('env::remove_var("CHROME_CRASHPAD_PIPE_NAME")')
    const spawnIndex = source.indexOf('Command::new(&electron_path)')

    // Why: the child inherits our environment block, so the stale pipe must be gone before
    // it is spawned (stablyai/orca#19792).
    expect(cleanupIndex).toBeGreaterThanOrEqual(0)
    expect(spawnIndex).toBeGreaterThan(cleanupIndex)
  })
})
