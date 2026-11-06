import type { CliInstallStatus } from '../../shared/cli-install-types'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const runWslProcessMock = vi.hoisted(() => vi.fn())

vi.mock('../wsl/execution/wsl-runner', () => ({
  runWslProcess: runWslProcessMock
}))

import { WslCliInstaller, _internals } from './wsl-cli-installer'

function makeHostStatus(
  launcherPath = 'C:\\Users\\me\\AppData\\Local\\Programs\\Orca\\resources\\bin\\orca.exe'
) {
  return {
    platform: 'win32',
    commandName: 'orca',
    commandPath: launcherPath,
    pathDirectory: 'C:\\Users\\me\\AppData\\Local\\Programs\\Orca\\resources\\bin',
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

// Frozen from v1.4.138-rc.2: the upgrade regression only reproduces when the
// persisted managed script still names the pre-native Windows batch launcher.
const PRE_RC4_MANAGED_WSL_LAUNCHER = `#!/usr/bin/env bash
set -euo pipefail
# Orca managed WSL CLI launcher
# ORCA_WIN_LAUNCHER_B64=QzpcUHJvZ3JhbSBGaWxlc1xPcmNhXHJlc291cmNlc1xiaW5cb3JjYS5jbWQ=
ORCA_WIN_LAUNCHER='C:\\Program Files\\Orca\\resources\\bin\\orca.cmd'
ORCA_BRIDGE_PS1='/home/alice/.local/share/orca/orca-wsl-bridge.ps1'
if command -v powershell.exe >/dev/null 2>&1; then
  ORCA_POWERSHELL=powershell.exe
elif [ -x /mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe ]; then
  ORCA_POWERSHELL=/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe
else
  echo "Orca WSL CLI requires Windows interop and could not find powershell.exe." >&2
  exit 1
fi
ORCA_BRIDGE_PS1_WIN=$(wslpath -w "$ORCA_BRIDGE_PS1")
exec "$ORCA_POWERSHELL" -NoProfile -ExecutionPolicy Bypass -File "$ORCA_BRIDGE_PS1_WIN" "$ORCA_WIN_LAUNCHER" "$@"
`

describe('WslCliInstaller', () => {
  beforeEach(() => {
    runWslProcessMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it.skipIf(process.platform === 'win32')(
    'rolls both files back when the command replacement fails after the bridge move',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'orca-wsl-cli-rollback-'))
      const home = join(root, 'home with spaces')
      const commandPath = join(home, '.local', 'bin', 'orca-ide')
      const bridgePath = join(home, '.local', 'share', 'orca', 'orca-wsl-bridge.ps1')
      const bridge = _internals.buildWslBridgeScript()
      await mkdir(join(home, '.local', 'bin'), { recursive: true })
      await mkdir(join(home, '.local', 'share', 'orca'), { recursive: true })
      await writeFile(commandPath, PRE_RC4_MANAGED_WSL_LAUNCHER, 'utf8')
      await writeFile(bridgePath, bridge, 'utf8')

      const runner = async (_distro: string, command: string): Promise<string> => {
        if (command.includes('printf %s "$HOME"')) {
          return home
        }
        if (command.includes('cat > "$command_tmp"')) {
          const executableCommand = command
            .split('\n')
            .map((line) => (line.startsWith('mv -f "$command_tmp" ') ? 'exit 71' : line))
            .join('\n')
          return execFileSync('bash', ['-c', executableCommand], { encoding: 'utf8' })
        }
        if (command.includes('command -v powershell.exe')) {
          return 'yes'
        }
        if (command.includes('case ":$PATH:"')) {
          return 'yes'
        }
        return execFileSync('bash', ['-c', command], { encoding: 'utf8' })
      }
      const installer = new WslCliInstaller({
        platform: 'win32',
        distro: 'Ubuntu',
        hostInstaller: {
          getStatus: async () => makeHostStatus('C:\\Program Files\\Orca\\resources\\bin\\orca.exe')
        },
        wslRunner: runner
      })

      try {
        await expect(installer.repairManagedRegistration()).rejects.toThrow()
        await expect(readFile(commandPath, 'utf8')).resolves.toBe(PRE_RC4_MANAGED_WSL_LAUNCHER)
        await expect(readFile(bridgePath, 'utf8')).resolves.toBe(bridge)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  )
})
