import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AgentHookInstallStatus } from '../../shared/agent-hook-types'
import { getBundledLauncherPath } from '../cli/bundled-cli-launcher-path'

const electron = vi.hoisted(() => ({
  exit: vi.fn(),
  requestSingleInstanceLock: vi.fn(),
  BrowserWindow: vi.fn(),
  handle: vi.fn()
}))
const appData = vi.hoisted(() => ({ ensure: vi.fn() }))
const hooks = vi.hoisted(() => ({
  remove: vi.fn<() => Promise<AgentHookInstallStatus[]>>(async () => [])
}))

vi.mock('electron', () => ({
  app: {
    exit: electron.exit,
    getPath: () => '/user-data',
    setPath: vi.fn(),
    requestSingleInstanceLock: electron.requestSingleInstanceLock
  },
  BrowserWindow: electron.BrowserWindow,
  ipcMain: { handle: electron.handle }
}))
vi.mock('./windows-app-data-path', () => ({ ensureWindowsAppDataPath: appData.ensure }))
vi.mock('../agent-hooks/managed-agent-hook-controls', () => ({
  removeManagedAgentHooks: hooks.remove
}))

import {
  AGENT_HOOKS_UNINSTALL_FLAG,
  removeAgentHooksForUninstall,
  runAgentHooksUninstallPreflight
} from './agent-hooks-uninstall-preflight'

function status(agent: 'claude' | 'codex', state: AgentHookInstallStatus['state']) {
  return { agent, state, configPath: '', managedHooksPresent: false, detail: null }
}

const nsis = (name: string): string =>
  readFileSync(new URL(`../../../config/nsis/${name}`, import.meta.url), 'utf8')

function realUninstallBranch(): string {
  const unInstall = nsis('orca-installer-hooks.nsh').slice(
    nsis('orca-installer-hooks.nsh').indexOf('!macro customUnInstall')
  )
  // The real-uninstall branch ends with the relocated daemon host's cleanup.
  return unInstall.slice(
    unInstall.indexOf('${ifNot} ${isUpdated}'),
    unInstall.indexOf('daemon-host-profiles')
  )
}

describe('managed agent hook removal on uninstall', () => {
  it('succeeds only when no agent reports an error', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(
      removeAgentHooksForUninstall(async () => [
        status('claude', 'not_installed'),
        status('codex', 'not_installed')
      ])
    ).resolves.toBe(0)
    await expect(
      removeAgentHooksForUninstall(async () => [
        status('claude', 'not_installed'),
        status('codex', 'error')
      ])
    ).resolves.toBe(1)
    await expect(
      removeAgentHooksForUninstall(async () => {
        throw new Error('settings unreadable')
      })
    ).resolves.toBe(1)
  })

  it('ignores ordinary launches', () => {
    expect(runAgentHooksUninstallPreflight(['Orca.exe'])).toBe(false)
    expect(hooks.remove).not.toHaveBeenCalled()
  })

  it('removes every agent and exits, opening no window, lock or IPC', async () => {
    electron.exit.mockClear()
    hooks.remove.mockResolvedValueOnce([status('claude', 'not_installed')])

    expect(runAgentHooksUninstallPreflight(['Orca.exe', AGENT_HOOKS_UNINSTALL_FLAG])).toBe(true)

    await vi.waitFor(() => expect(electron.exit).toHaveBeenCalledWith(0))
    expect(hooks.remove).toHaveBeenCalledExactlyOnceWith()
    expect(electron.BrowserWindow).not.toHaveBeenCalled()
    expect(electron.requestSingleInstanceLock).not.toHaveBeenCalled()
    expect(electron.handle).not.toHaveBeenCalled()
  })

  it('exits 1 rather than leaving an error box when setup throws', () => {
    vi.useFakeTimers()
    electron.exit.mockClear()
    appData.ensure.mockImplementationOnce(() => {
      throw new Error('Orca could not find the Windows roaming AppData folder')
    })
    try {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      expect(runAgentHooksUninstallPreflight(['Orca.exe', AGENT_HOOKS_UNINSTALL_FLAG])).toBe(true)
      expect(electron.exit).toHaveBeenCalledExactlyOnceWith(1)
      // The timer armed before setup is cleared, so it can't exit a second time.
      vi.runAllTimers()
      expect(electron.exit).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('the NSIS uninstaller', () => {
  it('removes agent hooks on a real uninstall only, after the app is gone, never blocking', () => {
    const branch = realUninstallBranch()
    const launch = branch.indexOf(
      `nsExec::Exec '"$INSTDIR\\\${APP_EXECUTABLE_FILENAME}" ${AGENT_HOOKS_UNINSTALL_FLAG}'`
    )
    expect(launch).toBeGreaterThan(-1)
    // Killed first, so a running Orca cannot reinstall the hooks behind the removal.
    expect(launch).toBeGreaterThan(branch.indexOf('orca-terminal-daemon.exe'))
    // The exit code is popped and never checked.
    expect(branch.slice(launch).split('\n')[1].trim()).toBe('Pop $0')
    expect(nsis('orca-installer-hooks.nsh').split(AGENT_HOOKS_UNINSTALL_FLAG)).toHaveLength(2)
  })

  it('keeps the hooks while another Orca install for this user still uses them', () => {
    const branch = realUninstallBranch()
    const launch = branch.indexOf(AGENT_HOOKS_UNINSTALL_FLAG)
    const check = branch.indexOf('!insertmacro ORCA_OTHER_INSTALL_STATE $1')
    expect(check).toBeGreaterThan(-1)
    // Only a definite "no other install" runs the removal; "other" and "unknown" skip it.
    const gate = branch.lastIndexOf('${if} $1 == "none"', launch)
    expect(gate).toBeGreaterThan(check)
    expect(branch.slice(gate, launch)).not.toContain('${endIf}')
    expect(nsis('orca-installer-hooks.nsh')).toContain(
      '!include "${__FILEDIR__}\\orca-other-install-check.nsh"'
    )

    const detect = nsis('orca-other-install-check.nsh')
    // Both registrations a second install can have, by the key the installer writes.
    expect(detect).toContain(
      '!insertmacro ORCA_CHECK_ONE_REGISTRATION ${ORCA_OTHER_INSTALL_HKCU} HKCU ${OUT}'
    )
    expect(detect).toContain(
      '!insertmacro ORCA_CHECK_ONE_REGISTRATION ${ORCA_OTHER_INSTALL_HKLM} HKLM ${OUT}'
    )
    expect(detect).toContain('ReadRegStr $R5 ${HIVE} "${INSTALL_REGISTRY_KEY}" InstallLocation')
    // Our own registration is excluded, and the other one must still have the app.
    expect(detect).toContain('${elseIf} $R5 != $INSTDIR')
    expect(detect).toContain('${andIf} ${FileExists} "$R5\\${APP_EXECUTABLE_FILENAME}"')
    // A read failure other than "no such key" reports unknown, which skips the removal.
    expect(detect).toMatch(
      /\$\{elseIf\} \$R7 != \$\{ORCA_ERROR_FILE_NOT_FOUND\}\s+StrCpy \$\{OUT\} "unknown"/
    )
    expect(detect).not.toMatch(/nsExec|ExecWait|powershell/i)
  })

  it('keeps the hooks when an Orca registration names no install location', () => {
    const detect = nsis('orca-other-install-check.nsh')
    // An opened key whose InstallLocation reads empty is doubtful, never "none".
    expect(detect).toMatch(
      /ReadRegStr \$R5 \$\{HIVE\} "\$\{INSTALL_REGISTRY_KEY\}" InstallLocation[\s\S]*?\$\{if\} \$R5 == ""\s+(?:;[^\n]*\n\s+)?StrCpy \$\{OUT\} "unknown"\s+\$\{elseIf\} \$R5 != \$INSTDIR/
    )
  })

  it("removes the `orca` command's PATH entry on a real uninstall only", () => {
    const hooksFile = nsis('orca-installer-hooks.nsh')
    expect(hooksFile).toContain('!include "${__FILEDIR__}\\orca-user-path-cleanup.nsh"')
    const call = '!insertmacro ORCA_REMOVE_USER_PATH_ENTRY "$INSTDIR\\resources\\bin"'
    expect(realUninstallBranch()).toContain(call)
    expect(hooksFile.split(call)).toHaveLength(2)
    // The directory the app registers: the packaged launcher's folder.
    const launcher = getBundledLauncherPath('win32', join('INSTDIR', 'resources'))
    expect(
      dirname(launcher ?? '')
        .split(/[\\/]/)
        .slice(-2)
    ).toEqual(['resources', 'bin'])
  })

  it('edits PATH natively, keeps its type, and never writes back a truncated read', () => {
    const cleanup = nsis('orca-user-path-cleanup.nsh')
    const code = cleanup
      .split('\n')
      .filter((line) => !line.trim().startsWith(';'))
      .join('\n')
    expect(code).not.toMatch(/nsExec|ExecWait|powershell|reg\.exe|reg add/i)
    expect(cleanup).toContain('IntOp $R2 ${NSIS_MAX_STRLEN} - 1')
    expect(cleanup).toMatch(/\$\{andIf\} \$R1 < \$R2/)
    expect(cleanup).toContain('WriteRegExpandStr HKCU "Environment" "Path" $R3')
    expect(cleanup).toContain('WriteRegStr HKCU "Environment" "Path" $R3')
    // Only a removal rewrites PATH, and only with a value type it actually read.
    expect(cleanup).toMatch(/\$\{if\} \$R7 == 1\s+\$\{andIf\} \$R8 != ""/)
    expect(cleanup.indexOf('${if} $R7 == 1')).toBeLessThan(cleanup.indexOf('WriteRegExpandStr'))
    expect(cleanup).toContain('StrCpy $R8 ""')
    expect(cleanup).toMatch(/\$\{if\} \$R7 == 0\s+StrCpy \$R8 \$R4/)
    expect(cleanup).toContain('${elseIf} $R8 == ${ORCA_REG_SZ}')
    expect(cleanup).not.toMatch(/\$\{else\}\s+WriteRegStr/)
  })
})
