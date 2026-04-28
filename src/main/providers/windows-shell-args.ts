import { win32 as pathWin32 } from 'path'

/** Result of resolving a Windows shell to its launch args + effective cwd.
 *
 *  Why this module exists: both the in-process LocalPtyProvider and the
 *  daemon-subprocess spawner must produce IDENTICAL launch args for the same
 *  (shellPath, cwd) pair. A prior drift let the daemon path always spawn
 *  PowerShell regardless of which shell the user picked — the renderer's
 *  shellOverride never reached the daemon's shell-args branches. Sharing the
 *  decision here keeps both paths honest. */
export type WindowsShellLaunchArgs = {
  shellArgs: string[]
  /** The cwd node-pty should be spawned with. WSL cannot cd into a Windows
   *  path, so the wsl.exe branch returns the user's home as the effective cwd
   *  and injects `cd '<linux path>'` into shellArgs instead. */
  effectiveCwd: string
  /** The path the caller should still validate exists on disk. Equals cwd in
   *  every branch except wsl.exe (which validates the Windows cwd even though
   *  the shell itself launches from $HOME). */
  validationCwd: string
}

/** Build the argv + effective cwd for a Windows shell launch.
 *
 *  - cmd.exe: `/K chcp 65001 > nul` so multi-byte CJK output renders correctly.
 *  - powershell.exe / pwsh.exe: dot-source $PROFILE and force UTF-8 I/O so
 *    oh-my-posh / starship / PSReadLine keep working. `-NoExit` alone would
 *    skip the profile.
 *  - wsl.exe: translate the Windows cwd to /mnt/<drive>/... and enter a login
 *    bash inside the default distro.
 *  - anything else: no args, same cwd. */
export function resolveWindowsShellLaunchArgs(
  shellPath: string,
  cwd: string,
  defaultCwd: string
): WindowsShellLaunchArgs {
  const shellBasename = pathWin32.basename(shellPath).toLowerCase()

  if (shellBasename === 'cmd.exe') {
    return {
      shellArgs: ['/K', 'chcp 65001 > nul'],
      effectiveCwd: cwd,
      validationCwd: cwd
    }
  }

  if (shellBasename === 'powershell.exe' || shellBasename === 'pwsh.exe') {
    return {
      shellArgs: [
        '-NoExit',
        '-Command',
        'try { . $PROFILE } catch {}; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; [Console]::InputEncoding = [System.Text.Encoding]::UTF8'
      ],
      effectiveCwd: cwd,
      validationCwd: cwd
    }
  }

  if (shellBasename === 'wsl.exe') {
    const driveMatch = cwd.replace(/\\/g, '/').match(/^([A-Za-z]):\/?(.*)$/)
    const linuxCwd = driveMatch ? `/mnt/${driveMatch[1].toLowerCase()}/${driveMatch[2]}` : '/mnt/c'
    const escapedLinuxCwd = linuxCwd.replace(/'/g, "'\\''")
    return {
      shellArgs: ['--', 'bash', '-c', `cd '${escapedLinuxCwd}' && exec bash -l`],
      effectiveCwd: defaultCwd,
      validationCwd: cwd
    }
  }

  return {
    shellArgs: [],
    effectiveCwd: cwd,
    validationCwd: cwd
  }
}
