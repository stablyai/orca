import type { CliInstallStatus } from '../../shared/cli-install-types'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const execFileMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  execFile: execFileMock
}))

import { WslCliInstaller, _internals } from './wsl-cli-installer'
import { reconcileManagedWslCliRegistrations } from './wsl-cli-registration-reconciliation'

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

function createWslRunner(
  initialFile: string | null = null,
  pathIncludesLocalBin = true,
  options: {
    initialBridge?: string | null
    initialLegacyFile?: string | null
    failInstall?: boolean
    interopReady?: boolean
  } = {}
) {
  const commandPath = '/home/alice/.local/bin/orca-ide'
  const legacyCommandPath = '/home/alice/.local/bin/orca'
  const bridgePath = '/home/alice/.local/share/orca/orca-wsl-bridge.ps1'
  const files = new Map<string, string>()
  if (initialFile !== null) {
    files.set(commandPath, initialFile)
  }
  if (
    options.initialBridge !== null &&
    (initialFile !== null || options.initialBridge !== undefined)
  ) {
    files.set(bridgePath, options.initialBridge ?? _internals.buildWslBridgeScript())
  }
  if (options.initialLegacyFile) {
    files.set(legacyCommandPath, options.initialLegacyFile)
  }
  const calls: string[] = []
  const runner = vi.fn(async (_distro: string, command: string) => {
    calls.push(command)
    if (command.includes('printf %s "$HOME"')) {
      return '/home/alice'
    }
    if (command.includes('case ":$PATH:"')) {
      return pathIncludesLocalBin ? 'yes' : 'no'
    }
    if (command.includes('cat > "$command_tmp"')) {
      if (options.failInstall) {
        throw new Error('simulated replacement failure')
      }
      if (
        files.has(bridgePath) &&
        !files.get(bridgePath)?.includes('# Orca managed WSL CLI PowerShell bridge')
      ) {
        throw new Error('__ORCA_CONFLICT__')
      }
      const launcher =
        command.match(/cat > "\$command_tmp" <<'ORCA_WSL_CLI'\n([\s\S]*)\nORCA_WSL_CLI/)?.[1] ?? ''
      const bridge =
        command.match(
          /cat > "\$bridge_tmp" <<'ORCA_WSL_BRIDGE'\n([\s\S]*)\nORCA_WSL_BRIDGE/
        )?.[1] ?? ''
      files.set(commandPath, launcher)
      files.set(bridgePath, bridge)
      if (files.get(legacyCommandPath)?.includes('# Orca managed WSL CLI launcher')) {
        files.delete(legacyCommandPath)
      }
      return ''
    }
    if (command.includes('command -v powershell.exe')) {
      return options.interopReady === false ? 'no' : 'yes'
    }
    if (command.includes('rm -f')) {
      if (command.includes(`rm -f '${commandPath}'`)) {
        if (
          files.has(bridgePath) &&
          !files.get(bridgePath)?.includes('# Orca managed WSL CLI PowerShell bridge')
        ) {
          throw new Error('__ORCA_CONFLICT__')
        }
        files.delete(commandPath)
        files.delete(bridgePath)
      }
      if (
        command.includes(legacyCommandPath) &&
        files.get(legacyCommandPath)?.includes('# Orca managed WSL CLI launcher')
      ) {
        files.delete(legacyCommandPath)
      }
      return ''
    }
    if (command.includes('cat ')) {
      if (command.includes(commandPath)) {
        return files.get(commandPath) ?? '__ORCA_MISSING__'
      }
      if (command.includes(bridgePath)) {
        return files.get(bridgePath) ?? '__ORCA_MISSING__'
      }
      if (command.includes(legacyCommandPath)) {
        return files.get(legacyCommandPath) ?? '__ORCA_MISSING__'
      }
    }
    throw new Error(`Unexpected WSL command: ${command}`)
  })
  return {
    runner,
    calls,
    getBridge: () => files.get(bridgePath) ?? null,
    getFile: () => files.get(commandPath) ?? null,
    getLegacyFile: () => files.get(legacyCommandPath) ?? null
  }
}

describe('WslCliInstaller', () => {
  beforeEach(() => {
    execFileMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

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
      launcherPath: 'C:\\Users\\me\\AppData\\Local\\Programs\\Orca\\resources\\bin\\orca.exe'
    })
    expect(wsl.getFile()).toBe(
      _internals.buildWslLauncher(
        'C:\\Users\\me\\AppData\\Local\\Programs\\Orca\\resources\\bin\\orca.exe',
        '/home/alice/.local/share/orca/orca-wsl-bridge.ps1'
      )
    )
    expect(wsl.getBridge()).toBe(_internals.buildWslBridgeScript())
    const installCommand = wsl.calls.find((command) => command.includes('cat > "$command_tmp"'))
    expect(installCommand).toBeDefined()
    expect(installCommand).toContain("legacy_command_path='/home/alice/.local/bin/orca'")
    expect(installCommand).toContain('rm -f "$legacy_command_path"')
    // Why: the new bridge accepts the old launcher's positional arguments, so
    // publishing it first keeps interrupted upgrades usable.
    const bridgePublishIndex = installCommand?.indexOf('mv -f "$bridge_tmp"') ?? -1
    const launcherPublishIndex = installCommand?.indexOf('mv -f "$command_tmp"') ?? -1
    expect(bridgePublishIndex).toBeGreaterThan(-1)
    expect(bridgePublishIndex).toBeLessThan(launcherPublishIndex)
    expect(installCommand).toContain('[ ! -L "$legacy_command_path" ]')
  })

  it('continues checking WSL when the host launcher exists but host PATH is unknown', async () => {
    const wsl = createWslRunner()
    const hostStatus = {
      ...makeHostStatus(),
      pathConfigured: null,
      detail: 'Orca could not read the Windows user PATH registry value.'
    } satisfies CliInstallStatus
    const installer = new WslCliInstaller({
      platform: 'win32',
      distro: 'Ubuntu',
      hostInstaller: { getStatus: async () => hostStatus },
      wslRunner: wsl.runner
    })

    await expect(installer.getStatus()).resolves.toMatchObject({
      supported: true,
      state: 'not_installed',
      commandPath: '/home/alice/.local/bin/orca-ide'
    })
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

  it('accepts current managed WSL scripts with an extra heredoc trailing newline', async () => {
    const launcher = `${_internals.buildWslLauncher(
      'C:\\Orca\\orca.cmd',
      '/home/alice/.local/share/orca/orca-wsl-bridge.ps1'
    )}\n`
    const wsl = createWslRunner(launcher)
    const installer = new WslCliInstaller({
      platform: 'win32',
      distro: 'Ubuntu',
      hostInstaller: { getStatus: async () => makeHostStatus('C:\\Orca\\orca.cmd') },
      wslRunner: async (distro, command) => {
        if (command.includes('cat /home/alice/.local/share/orca/orca-wsl-bridge.ps1')) {
          return `${_internals.buildWslBridgeScript()}\n`
        }
        return wsl.runner(distro, command)
      }
    })

    await expect(installer.getStatus()).resolves.toMatchObject({
      state: 'installed',
      currentTarget: 'C:\\Orca\\orca.cmd'
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

    expect(launcher).toContain('command -v powershell.exe')
    expect(launcher).toContain('/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe')
    expect(launcher).toContain(
      'Orca WSL CLI requires Windows interop and could not find powershell.exe.'
    )
    expect(launcher).toContain('"$ORCA_POWERSHELL" -NoProfile -ExecutionPolicy Bypass -File')
    expect(launcher).toContain('ORCA_WSL_CWD=$(pwd -P 2>/dev/null) || {')
    expect(launcher).toContain('ORCA_WSL_CWD=/')
    expect(launcher).toContain('cd /')
    expect(launcher).toContain('ORCA_WSL_CWD_WIN=$(wslpath -w "$ORCA_WSL_CWD")')
    expect(launcher.indexOf('ORCA_WSL_CWD=$(pwd -P')).toBeLessThan(
      launcher.indexOf('ORCA_BRIDGE_PS1_WIN=$(wslpath')
    )
    expect(launcher).toContain('"$ORCA_WIN_LAUNCHER" -WslCwd "$ORCA_WSL_CWD_WIN" "$@"')
    expect(launcher).not.toContain('-Command')
    expect(bridge).toContain('[CmdletBinding(PositionalBinding=$false)]')
    expect(bridge).toContain('[Parameter(Mandatory=$true, Position=0)]')
    expect(bridge).toContain('[string]$WslCwd')
    expect(bridge).toContain('[Parameter(ValueFromRemainingArguments=$true)]')
    expect(bridge).toContain('if ([string]::IsNullOrEmpty($WslCwd))')
    expect(bridge).toContain('$env:ORCA_CLI_CWD = $WslCwd')
    expect(bridge).toContain('Push-Location -LiteralPath (Split-Path -Parent $OrcaLauncher)')
    expect(bridge).toContain('& $OrcaLauncher @ForwardArgs')
    const nullExitCodeBranch = bridge.indexOf('if ($null -eq $LASTEXITCODE)')
    const invocationFailureBranch = bridge.indexOf('if (-not $?)')
    expect(nullExitCodeBranch).toBeGreaterThan(-1)
    // Why: native launchers can set a non-zero LASTEXITCODE while $? is false;
    // checking the native status first preserves that specific exit code.
    expect(nullExitCodeBranch).toBeLessThan(invocationFailureBranch)
    expect(bridge).toContain('$exitCode = $LASTEXITCODE')
    expect(bridge).toContain('Remove-Item Env:ORCA_CLI_CWD -ErrorAction SilentlyContinue')
    expect(bridge).toContain('catch')
    expect(bridge).toContain('$exitCode = 1')
    expect(bridge).toContain('exit $exitCode')
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

  it('treats absolute Windows PowerShell as interop-ready when powershell.exe is missing from PATH', async () => {
    const wsl = createWslRunner()
    const installer = new WslCliInstaller({
      platform: 'win32',
      distro: 'Ubuntu',
      hostInstaller: { getStatus: async () => makeHostStatus() },
      wslRunner: async (distro, command) => {
        if (command.includes('command -v powershell.exe') && !command.includes('cat >')) {
          expect(command).toContain('/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe')
          return 'yes'
        }
        return wsl.runner(distro, command)
      }
    })

    await expect(installer.getStatus()).resolves.toMatchObject({
      state: 'not_installed',
      commandPath: '/home/alice/.local/bin/orca-ide'
    })
  })

  it('marks stale managed launchers that point at the old app bin instead of packaged resources', async () => {
    const oldLauncher = _internals.buildWslLauncher(
      'C:\\Users\\me\\AppData\\Local\\Programs\\Orca\\bin\\orca.cmd',
      '/home/alice/.local/share/orca/orca-wsl-bridge.ps1'
    )
    const wsl = createWslRunner(oldLauncher)
    const installer = new WslCliInstaller({
      platform: 'win32',
      distro: 'Ubuntu',
      hostInstaller: { getStatus: async () => makeHostStatus() },
      wslRunner: wsl.runner
    })

    await expect(installer.getStatus()).resolves.toMatchObject({
      state: 'stale',
      currentTarget: 'C:\\Users\\me\\AppData\\Local\\Programs\\Orca\\bin\\orca.cmd',
      launcherPath: 'C:\\Users\\me\\AppData\\Local\\Programs\\Orca\\resources\\bin\\orca.exe'
    })

    await expect(installer.install()).resolves.toMatchObject({
      state: 'installed',
      currentTarget: 'C:\\Users\\me\\AppData\\Local\\Programs\\Orca\\resources\\bin\\orca.exe'
    })
  })

  it('repairs the frozen pre-rc4 registration so orchestration send/reply reach native rc4', async () => {
    const nativeLauncher = 'C:\\Program Files\\Orca\\resources\\bin\\orca.exe'
    const wsl = createWslRunner(PRE_RC4_MANAGED_WSL_LAUNCHER)
    const installer = new WslCliInstaller({
      platform: 'win32',
      distro: 'Ubuntu',
      hostInstaller: { getStatus: async () => makeHostStatus(nativeLauncher) },
      wslRunner: wsl.runner
    })
    const orchestrationCalls = [
      ['orchestration', 'send', '--type', 'heartbeat'],
      ['orchestration', 'send', '--type', 'worker_done'],
      ['orchestration', 'reply', '--message', 'line one\nline two']
    ]
    const simulateRc4Launch = (args: string[]): number => {
      const target = _internals.parseManagedLauncherTarget(wsl.getFile() ?? '')
      return target?.toLowerCase().endsWith('orca.cmd') &&
        args[0] === 'orchestration' &&
        (args[1] === 'send' || args[1] === 'reply')
        ? 2
        : 0
    }

    expect(orchestrationCalls.map(simulateRc4Launch)).toEqual([2, 2, 2])

    await expect(
      reconcileManagedWslCliRegistrations({
        platform: 'win32',
        isPackaged: true,
        userDataPath: '/user-data',
        listDistros: async () => ['Ubuntu'],
        registry: {
          getCandidates: async () => ['Ubuntu'],
          recordObservations: async () => undefined
        },
        createInstaller: () => installer
      })
    ).resolves.toEqual([
      { distro: 'Ubuntu', outcome: 'repaired', state: 'installed', managed: true }
    ])
    await expect(installer.getStatus()).resolves.toMatchObject({
      state: 'installed',
      currentTarget: nativeLauncher
    })
    expect(orchestrationCalls.map(simulateRc4Launch)).toEqual([0, 0, 0])
  })

  it('leaves unmanaged WSL commands and conflicting bridges untouched during automatic repair', async () => {
    const unmanaged = '#!/usr/bin/env bash\necho user-owned\n'
    const wsl = createWslRunner(unmanaged)
    const installer = new WslCliInstaller({
      platform: 'win32',
      distro: 'Ubuntu',
      hostInstaller: { getStatus: async () => makeHostStatus() },
      wslRunner: wsl.runner
    })

    await expect(installer.repairManagedRegistration()).resolves.toMatchObject({
      changed: false,
      status: { state: 'conflict' }
    })
    expect(wsl.getFile()).toBe(unmanaged)
    expect(wsl.calls.some((command) => command.includes('cat > "$command_tmp"'))).toBe(false)
  })

  it('repairs a managed launcher whose bridge is missing, but preserves a conflicting bridge', async () => {
    const nativeLauncher = 'C:\\Orca\\resources\\bin\\orca.exe'
    const missingBridge = createWslRunner(PRE_RC4_MANAGED_WSL_LAUNCHER, true, {
      initialBridge: null
    })
    const missingBridgeInstaller = new WslCliInstaller({
      platform: 'win32',
      distro: 'Ubuntu',
      hostInstaller: { getStatus: async () => makeHostStatus(nativeLauncher) },
      wslRunner: missingBridge.runner
    })

    await expect(missingBridgeInstaller.repairManagedRegistration()).resolves.toMatchObject({
      changed: true,
      status: { state: 'installed' }
    })
    expect(missingBridge.getBridge()).toBe(_internals.buildWslBridgeScript())

    const staleBridge = createWslRunner(PRE_RC4_MANAGED_WSL_LAUNCHER, true, {
      initialBridge: '# Orca managed WSL CLI PowerShell bridge\nWrite-Output "stale"\n'
    })
    const staleBridgeInstaller = new WslCliInstaller({
      platform: 'win32',
      distro: 'Ubuntu',
      hostInstaller: { getStatus: async () => makeHostStatus(nativeLauncher) },
      wslRunner: staleBridge.runner
    })
    await expect(staleBridgeInstaller.repairManagedRegistration()).resolves.toMatchObject({
      changed: true,
      status: { state: 'installed' }
    })
    expect(staleBridge.getBridge()).toBe(_internals.buildWslBridgeScript())

    const conflictingBridge = createWslRunner(PRE_RC4_MANAGED_WSL_LAUNCHER, true, {
      initialBridge: 'Write-Output "user-owned bridge"\n'
    })
    const conflictingBridgeInstaller = new WslCliInstaller({
      platform: 'win32',
      distro: 'Ubuntu',
      hostInstaller: { getStatus: async () => makeHostStatus(nativeLauncher) },
      wslRunner: conflictingBridge.runner
    })

    // Why: a stale launcher with a user-owned bridge must surface as a
    // non-throwing conflict, not retry a doomed install on every startup.
    await expect(conflictingBridgeInstaller.repairManagedRegistration()).resolves.toMatchObject({
      changed: false,
      managed: true,
      status: { state: 'conflict' }
    })
    expect(conflictingBridge.getBridge()).toBe('Write-Output "user-owned bridge"\n')
    expect(conflictingBridge.getFile()).toBe(PRE_RC4_MANAGED_WSL_LAUNCHER)
    expect(
      conflictingBridge.calls.some((command) => command.includes('cat > "$command_tmp"'))
    ).toBe(false)
  })

  it('retains command ownership when only the bridge conflicts', async () => {
    const nativeLauncher = 'C:\\Orca\\resources\\bin\\orca.exe'
    const currentLauncher = _internals.buildWslLauncher(
      nativeLauncher,
      '/home/alice/.local/share/orca/orca-wsl-bridge.ps1'
    )
    const wsl = createWslRunner(currentLauncher, true, {
      initialBridge: 'Write-Output "user-owned bridge"\n'
    })
    const installer = new WslCliInstaller({
      platform: 'win32',
      distro: 'Ubuntu',
      hostInstaller: { getStatus: async () => makeHostStatus(nativeLauncher) },
      wslRunner: wsl.runner
    })

    await expect(installer.repairManagedRegistration()).resolves.toMatchObject({
      changed: false,
      managed: true,
      status: { state: 'conflict' }
    })
    expect(wsl.getBridge()).toBe('Write-Output "user-owned bridge"\n')
    expect(wsl.getFile()).toBe(currentLauncher)
  })

  it('moves a legacy-only managed registration to orca-ide without touching unmanaged names', async () => {
    const nativeLauncher = 'C:\\Orca\\resources\\bin\\orca.exe'
    const managedLegacy = createWslRunner(null, true, {
      initialBridge: _internals.buildWslBridgeScript(),
      initialLegacyFile: PRE_RC4_MANAGED_WSL_LAUNCHER
    })
    const installer = new WslCliInstaller({
      platform: 'win32',
      distro: 'Ubuntu',
      hostInstaller: { getStatus: async () => makeHostStatus(nativeLauncher) },
      wslRunner: managedLegacy.runner
    })

    await expect(installer.repairManagedRegistration()).resolves.toMatchObject({
      changed: true,
      status: { state: 'installed', currentTarget: nativeLauncher }
    })
    expect(managedLegacy.getLegacyFile()).toBeNull()

    const unmanagedLegacy = createWslRunner(null, true, {
      initialLegacyFile: '#!/bin/sh\necho user-owned\n'
    })
    const unmanagedInstaller = new WslCliInstaller({
      platform: 'win32',
      distro: 'Ubuntu',
      hostInstaller: { getStatus: async () => makeHostStatus(nativeLauncher) },
      wslRunner: unmanagedLegacy.runner
    })
    await expect(unmanagedInstaller.repairManagedRegistration()).resolves.toMatchObject({
      changed: false,
      status: { state: 'not_installed' }
    })
    expect(unmanagedLegacy.getLegacyFile()).toBe('#!/bin/sh\necho user-owned\n')
  })

  it('does not adopt a legacy-managed registration when the bridge is user-owned', async () => {
    const wsl = createWslRunner(null, true, {
      initialBridge: 'Write-Output "user-owned bridge"\n',
      initialLegacyFile: PRE_RC4_MANAGED_WSL_LAUNCHER
    })
    const installer = new WslCliInstaller({
      platform: 'win32',
      distro: 'Ubuntu',
      hostInstaller: { getStatus: async () => makeHostStatus() },
      wslRunner: wsl.runner
    })

    // Why: adoption would fail install()'s bridge guard on every startup;
    // repair must report blocked-but-managed instead of a doomed install.
    await expect(installer.repairManagedRegistration()).resolves.toMatchObject({
      changed: false,
      managed: true,
      status: { state: 'not_installed' }
    })
    expect(wsl.getLegacyFile()).toBe(PRE_RC4_MANAGED_WSL_LAUNCHER)
    expect(wsl.calls.some((command) => command.includes('cat > "$command_tmp"'))).toBe(false)
  })

  it('removes the managed legacy launcher on removal so reconciliation cannot re-adopt it', async () => {
    const nativeLauncher = 'C:\\Orca\\resources\\bin\\orca.exe'
    const managedLegacy = createWslRunner(null, true, {
      initialBridge: _internals.buildWslBridgeScript(),
      initialLegacyFile: PRE_RC4_MANAGED_WSL_LAUNCHER
    })
    const managedLegacyInstaller = new WslCliInstaller({
      platform: 'win32',
      distro: 'Ubuntu',
      hostInstaller: { getStatus: async () => makeHostStatus(nativeLauncher) },
      wslRunner: managedLegacy.runner
    })
    await expect(managedLegacyInstaller.remove()).resolves.toMatchObject({
      state: 'not_installed'
    })
    expect(managedLegacy.getLegacyFile()).toBeNull()

    const unmanagedLegacy = createWslRunner(null, true, {
      initialLegacyFile: '#!/bin/sh\necho user-owned\n'
    })
    const unmanagedInstaller2 = new WslCliInstaller({
      platform: 'win32',
      distro: 'Ubuntu',
      hostInstaller: { getStatus: async () => makeHostStatus(nativeLauncher) },
      wslRunner: unmanagedLegacy.runner
    })
    await expect(unmanagedInstaller2.remove()).resolves.toMatchObject({
      state: 'not_installed'
    })
    expect(unmanagedLegacy.getLegacyFile()).toBe('#!/bin/sh\necho user-owned\n')

    const installedWithLegacy = createWslRunner(
      _internals.buildWslLauncher(
        nativeLauncher,
        '/home/alice/.local/share/orca/orca-wsl-bridge.ps1'
      ),
      true,
      { initialLegacyFile: PRE_RC4_MANAGED_WSL_LAUNCHER }
    )
    const installedInstaller = new WslCliInstaller({
      platform: 'win32',
      distro: 'Ubuntu',
      hostInstaller: { getStatus: async () => makeHostStatus(nativeLauncher) },
      wslRunner: installedWithLegacy.runner
    })
    await expect(installedInstaller.remove()).resolves.toMatchObject({ state: 'not_installed' })
    expect(installedWithLegacy.getFile()).toBeNull()
    expect(installedWithLegacy.getLegacyFile()).toBeNull()
  })

  it('keeps the pre-rc4 files on a transactional replacement failure', async () => {
    const bridge = _internals.buildWslBridgeScript()
    const wsl = createWslRunner(PRE_RC4_MANAGED_WSL_LAUNCHER, true, {
      initialBridge: bridge,
      failInstall: true
    })
    const installer = new WslCliInstaller({
      platform: 'win32',
      distro: 'Ubuntu',
      hostInstaller: {
        getStatus: async () => makeHostStatus('C:\\Program Files\\Orca\\resources\\bin\\orca.exe')
      },
      wslRunner: wsl.runner
    })

    await expect(installer.repairManagedRegistration()).rejects.toThrow(
      'simulated replacement failure'
    )
    expect(wsl.getFile()).toBe(PRE_RC4_MANAGED_WSL_LAUNCHER)
    expect(wsl.getBridge()).toBe(bridge)
    const installCommand = wsl.calls.find((command) => command.includes('cat > "$command_tmp"'))
    expect(installCommand).toContain('rollback() {')
    expect(installCommand).toContain('set +e')
    expect(installCommand).toContain('bridge_backup="${bridge_tmp}.backup"')
    expect(installCommand).toContain('cp -p')
    expect(installCommand).toContain('elif [ "$bridge_touched" -eq 1 ]')
    expect(installCommand).toContain('committed=1')
    expect(installCommand).toContain('flock -x -w 30 9')
    // Why: the command replace must stay one atomic rename; a mv-based backup
    // would leave a window where a concurrent shell finds no orca-ide at all.
    expect(installCommand).not.toContain('command_backup')
    expect(installCommand).not.toContain(`mv -f '/home/alice/.local/bin/orca-ide'`)
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

  it('skips automatic repair when WSL interop is unavailable', async () => {
    const wsl = createWslRunner(PRE_RC4_MANAGED_WSL_LAUNCHER, true, { interopReady: false })
    const installer = new WslCliInstaller({
      platform: 'win32',
      distro: 'Ubuntu',
      hostInstaller: { getStatus: async () => makeHostStatus() },
      wslRunner: wsl.runner
    })

    await expect(installer.repairManagedRegistration()).resolves.toMatchObject({
      changed: false,
      status: { state: 'unsupported' }
    })
    expect(wsl.getFile()).toBe(PRE_RC4_MANAGED_WSL_LAUNCHER)
  })

  it('is idempotent after repairing an old managed registration', async () => {
    const nativeLauncher = 'D:\\Custom Orca\\resources\\bin\\orca.exe'
    const wsl = createWslRunner(PRE_RC4_MANAGED_WSL_LAUNCHER)
    const installer = new WslCliInstaller({
      platform: 'win32',
      distro: 'Ubuntu',
      hostInstaller: { getStatus: async () => makeHostStatus(nativeLauncher) },
      wslRunner: wsl.runner
    })

    await expect(installer.repairManagedRegistration()).resolves.toMatchObject({ changed: true })
    await expect(installer.repairManagedRegistration()).resolves.toMatchObject({ changed: false })
    expect(wsl.calls.filter((command) => command.includes('cat > "$command_tmp"'))).toHaveLength(1)
    expect(wsl.getFile()).toContain("ORCA_WIN_LAUNCHER='D:\\Custom Orca\\resources\\bin\\orca.exe'")
  })

  it('settles when wsl.exe never reports completion', async () => {
    vi.useFakeTimers()
    const killMock = vi.fn()
    execFileMock.mockImplementation(() => ({ kill: killMock }))
    const installer = new WslCliInstaller({
      platform: 'win32',
      distro: 'Ubuntu',
      hostInstaller: { getStatus: async () => makeHostStatus() }
    })

    const promise = installer.getStatus()
    let settled = false
    void promise
      .catch(() => undefined)
      .finally(() => {
        settled = true
      })

    await vi.advanceTimersByTimeAsync(10_000)
    await Promise.resolve()

    expect(settled).toBe(true)
    await expect(promise).rejects.toThrow('WSL command timed out')
    expect(killMock).toHaveBeenCalled()
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
