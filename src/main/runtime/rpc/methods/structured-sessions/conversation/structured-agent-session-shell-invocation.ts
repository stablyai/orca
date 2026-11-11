import { basename } from 'node:path'

export const SHELL_COMMAND_CWD_FILE_ENV = 'ORCA_SHELL_CWD_FILE'
const SHELL_COMMAND_ENV = 'ORCA_SHELL_COMMAND'

const POSIX_SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh'])

function cwdCaptureScript(name: string): string | null {
  const command = `"$${SHELL_COMMAND_ENV}"`
  const file = `"$${SHELL_COMMAND_CWD_FILE_ENV}"`
  if (name === 'fish') {
    return `eval ${command}\nset -l __orca_status $status\npwd > ${file} 2>/dev/null\nexit $__orca_status`
  }
  if (POSIX_SHELLS.has(name)) {
    return `eval ${command}\n__orca_status=$?\npwd > ${file} 2>/dev/null\nexit $__orca_status`
  }
  return null
}

export function shellCommandInvocation(
  shell: string,
  command: string,
  platform: NodeJS.Platform = process.platform
): {
  args: string[]
  windowsVerbatimArguments?: true
  capturesCwd: boolean
  env?: Record<string, string>
} {
  const name = basename(shell.replaceAll('\\', '/'))
    .toLowerCase()
    .replace(/\.exe$/, '')
  if (platform === 'win32' && name === 'cmd') {
    return {
      args: ['/d', '/s', '/c', `"${command}"`],
      windowsVerbatimArguments: true,
      capturesCwd: false
    }
  }
  if (name.startsWith('powershell') || name.startsWith('pwsh')) {
    return { args: ['-NoProfile', '-NonInteractive', '-Command', command], capturesCwd: false }
  }
  const script = platform === 'win32' ? null : cwdCaptureScript(name)
  return script === null
    ? { args: ['-c', command], capturesCwd: false }
    : { args: ['-c', script], capturesCwd: true, env: { [SHELL_COMMAND_ENV]: command } }
}
