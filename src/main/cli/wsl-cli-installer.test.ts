import type { CliInstallStatus } from '../../shared/cli-install-types'
import { WslCliInstaller, _internals } from './wsl-cli-installer'
import { describe, expect, it, vi } from 'vitest'

function makeHostStatus(launcherPath = 'C:\\Users\\me\\AppData\\Local\\Orca\\bin\\orca.cmd') {
  return {
    platform: 'win32',
    commandName: 'orca',
    commandPath: 'C:\\Users\\me\\AppData\\Local\\Programs\\Orca\\bin\\orca.cmd',
    pathDirectory: 'C:\\Users\\me\\AppData\\Local\\Programs\\Orca\\bin',
    pathConfigured: true,
    launcherPath,
    installMethod: 'wrapper',
    supported: true,
    state: 'installed',
    currentTarget: launcherPath,
    unsupportedReason: null,
    detail: null
  } satisfies CliInstallStatus
}

function createWslRunner(initialFile: string | null = null, pathIncludesLocalBin = true) {
  const commandPath = '/home/alice/.local/bin/orca-ide'
  const bridgePath = '/home/alice/.local/share/orca/orca-wsl-bridge.ps1'
  const files = new Map<string, string>()
  if (initialFile !== null) {
    files.set(commandPath, initialFile)
    files.set(bridgePath, _internals.buildWslBridgeScript())
  }
  const calls: string[] = []
  const runner = vi.fn(async (_distro: string, command: string) => {
    calls.push(command)
    if (command.includes('printf %s "$HOME"')) {
      return '/home/alice'
    }
    if (command.includes('command -v powershell.exe')) {
      return 'yes'
    }
    if (command.includes('case ":$PATH:"')) {
      return pathIncludesLocalBin ? 'yes' : 'no'
    }
    if (command.includes('cat > "$command_tmp"')) {
      const launcher =
        command.match(/cat > "\$command_tmp" <<'ORCA_WSL_CLI'\n([\s\S]*)\nORCA_WSL_CLI/)?.[1] ?? ''
      const bridge =
        command.match(
          /cat > "\$bridge_tmp" <<'ORCA_WSL_BRIDGE'\n([\s\S]*)\nORCA_WSL_BRIDGE/
        )?.[1] ?? ''
      files.set(commandPath, launcher)
      files.set(bridgePath, bridge)
      return ''
    }
    if (command.includes('rm -f')) {
      if (
        files.has(bridgePath) &&
        !files.get(bridgePath)?.includes('# Orca managed WSL CLI PowerShell bridge')
      ) {
        throw new Error('__ORCA_CONFLICT__')
      }
      files.delete(commandPath)
      files.delete(bridgePath)
      return ''
    }
    if (command.includes('cat ')) {
      if (command.includes(commandPath)) {
        return files.get(commandPath) ?? '__ORCA_MISSING__'
      }
      if (command.includes(bridgePath)) {
        return files.get(bridgePath) ?? '__ORCA_MISSING__'
      }
    }
    throw new Error(`Unexpected WSL command: ${command}`)
  })
  return {
    runner,
    calls,
    getBridge: () => files.get(bridgePath) ?? null,
    getFile: () => files.get(commandPath) ?? null
  }
}

describe('WslCliInstaller', () => {
  it('installs a WSL launcher that forwards to the Windows Orca launcher', async () => {
    const wsl = createWslRunner()
    const installer = new WslCliInstaller({
      platform: 'win32',
      distro: 'Ubuntu',
      hostInstaller: { getStatus: async () => makeHostStatus() },
      wslRunner: wsl.runner
    })

    await expect(installer.getStatus()).resolves.toMatchObject({
      state: 'not_installed',
      commandPath: '/home/alice/.local/bin/orca-ide'
    })

    const installed = await installer.install()

    expect(installed).toMatchObject({
      state: 'installed',
      pathConfigured: true,
      launcherPath: 'C:\\Users\\me\\AppData\\Local\\Orca\\bin\\orca.cmd'
    })
    expect(wsl.getFile()).toBe(
      _internals.buildWslLauncher(
        'C:\\Users\\me\\AppData\\Local\\Orca\\bin\\orca.cmd',
        '/home/alice/.local/share/orca/orca-wsl-bridge.ps1'
      )
    )
    expect(wsl.getBridge()).toBe(_internals.buildWslBridgeScript())
    const installCommand = wsl.calls.find((command) => command.includes('cat > "$command_tmp"'))
    expect(installCommand).toContain("legacy_command_path='/home/alice/.local/bin/orca'")
    expect(installCommand).toContain('rm -f "$legacy_command_path"')
  })

  it('derives the shared WSL bridge path for current and legacy command names', () => {
    expect(_internals.getBridgePathFromCommandPath('/home/alice/.local/bin/orca-ide')).toBe(
      '/home/alice/.local/share/orca/orca-wsl-bridge.ps1'
    )
    expect(_internals.getBridgePathFromCommandPath('/home/alice/.local/bin/orca')).toBe(
      '/home/alice/.local/share/orca/orca-wsl-bridge.ps1'
    )
  })

  it('reports installed WSL launchers whose bin directory is missing from PATH', async () => {
    const launcher = _internals.buildWslLauncher(
      'C:\\Orca\\orca.cmd',
      '/home/alice/.local/share/orca/orca-wsl-bridge.ps1'
    )
    const wsl = createWslRunner(launcher, false)
    const installer = new WslCliInstaller({
      platform: 'win32',
      distro: 'Ubuntu',
      hostInstaller: { getStatus: async () => makeHostStatus('C:\\Orca\\orca.cmd') },
      wslRunner: wsl.runner
    })

    await expect(installer.getStatus()).resolves.toMatchObject({
      state: 'installed',
      pathConfigured: false,
      detail: expect.stringContaining('not on PATH')
    })
  })

  it('refuses to replace an unmanaged WSL command', async () => {
    const wsl = createWslRunner('#!/usr/bin/env bash\necho elsewhere\n')
    const installer = new WslCliInstaller({
      platform: 'win32',
      distro: 'Ubuntu',
      hostInstaller: { getStatus: async () => makeHostStatus() },
      wslRunner: wsl.runner
    })

    await expect(installer.getStatus()).resolves.toMatchObject({ state: 'conflict' })
    await expect(installer.install()).rejects.toThrow('Refusing to replace')
  })

  it('removes a managed WSL launcher', async () => {
    const wsl = createWslRunner(
      _internals.buildWslLauncher(
        'C:\\Orca\\orca.cmd',
        '/home/alice/.local/share/orca/orca-wsl-bridge.ps1'
      )
    )
    const installer = new WslCliInstaller({
      platform: 'win32',
      distro: 'Ubuntu',
      hostInstaller: { getStatus: async () => makeHostStatus('C:\\Orca\\orca.cmd') },
      wslRunner: wsl.runner
    })

    await expect(installer.remove()).resolves.toMatchObject({ state: 'not_installed' })
    expect(wsl.getFile()).toBeNull()
  })

  it('generates a launcher that forwards arguments through a PowerShell file bridge', () => {
    const launcher = _internals.buildWslLauncher(
      'C:\\Program Files\\Orca\\orca.cmd',
      '/home/alice/.local/share/orca/orca-wsl-bridge.ps1'
    )
    const bridge = _internals.buildWslBridgeScript()

    expect(launcher).toContain('powershell.exe -NoProfile -ExecutionPolicy Bypass -File')
    expect(launcher).toContain('"$ORCA_WIN_LAUNCHER" "$@"')
    expect(launcher).not.toContain('-Command')
    expect(bridge).toContain('[Parameter(ValueFromRemainingArguments=$true)]')
    expect(bridge).toContain('& $OrcaLauncher @ForwardArgs')
    expect(bridge).toContain('catch')
    expect(bridge).toContain('exit 1')
  })

  it('wraps WSL bash scripts as a single encoded command line', () => {
    const command = [
      'set -euo pipefail',
      `cat > "$command_tmp" <<'ORCA_WSL_CLI'`,
      '#!/usr/bin/env bash',
      'exec powershell.exe "$@"',
      'ORCA_WSL_CLI'
    ].join('\n')
    const wrapped = _internals.buildEncodedWslBashCommand(command)
    const encoded = wrapped.match(
      /^set -o pipefail; printf %s '([^']+)' \| base64 -d \| bash$/
    )?.[1]

    expect(wrapped).not.toContain('\n')
    expect(wrapped).toContain('set -o pipefail;')
    expect(encoded).toBeTruthy()
    expect(Buffer.from(encoded as string, 'base64').toString('utf8')).toBe(command)
  })

  it('refuses to remove an old managed launcher when the bridge path is user-owned', async () => {
    const oldLauncher = _internals.buildWslLauncher(
      'C:\\Old\\orca.cmd',
      '/home/alice/.local/share/orca/orca-wsl-bridge.ps1'
    )
    const wsl = createWslRunner(oldLauncher)
    const installer = new WslCliInstaller({
      platform: 'win32',
      distro: 'Ubuntu',
      hostInstaller: { getStatus: async () => makeHostStatus('C:\\Orca\\orca.cmd') },
      wslRunner: async (distro, command) => {
        if (command.includes('cat /home/alice/.local/share/orca/orca-wsl-bridge.ps1')) {
          return 'user bridge'
        }
        if (command.includes('rm -f')) {
          throw new Error('__ORCA_CONFLICT__')
        }
        return wsl.runner(distro, command)
      }
    })

    await expect(installer.remove()).rejects.toThrow('__ORCA_CONFLICT__')
  })
})
