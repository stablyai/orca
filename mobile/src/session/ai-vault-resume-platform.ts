import { parseWslUncPath } from '../../../src/shared/wsl-paths'
import type { MobileAiVaultResumeTargetStatus } from '../agent-history/agent-history-resume-target'

const NODE_PLATFORMS = new Set<NodeJS.Platform>([
  'aix',
  'android',
  'darwin',
  'freebsd',
  'haiku',
  'linux',
  'openbsd',
  'sunos',
  'win32',
  'cygwin',
  'netbsd'
])

export function readMobileRuntimeHostPlatform(statusResult: unknown): NodeJS.Platform | null {
  if (!statusResult || typeof statusResult !== 'object') {
    return null
  }
  const hostPlatform = (statusResult as { hostPlatform?: unknown }).hostPlatform
  return typeof hostPlatform === 'string' && NODE_PLATFORMS.has(hostPlatform as NodeJS.Platform)
    ? (hostPlatform as NodeJS.Platform)
    : null
}

export function readMobileRuntimeTerminalWindowsShell(statusResult: unknown): string | null {
  if (!statusResult || typeof statusResult !== 'object') {
    return null
  }
  const shell = (statusResult as { terminalWindowsShell?: unknown }).terminalWindowsShell
  if (typeof shell !== 'string') {
    return null
  }
  const trimmed = shell.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function resolveMobileAiVaultResumePlatform(
  targetStatus: MobileAiVaultResumeTargetStatus,
  hostPlatform: NodeJS.Platform | null,
  workspacePath?: string | null,
  terminalPlatform?: NodeJS.Platform | null
): NodeJS.Platform | null {
  if (targetStatus === 'ssh') {
    return 'linux'
  }
  if (targetStatus !== 'local') {
    return null
  }
  if (terminalPlatform === 'linux' && hostPlatform === 'win32') {
    return 'linux'
  }
  if (workspacePath && parseWslUncPath(workspacePath)) {
    return 'linux'
  }
  return hostPlatform
}

export function normalizeMobileAiVaultCodexHome(
  codexHome: string | null,
  platform: NodeJS.Platform
): string | null {
  if (!codexHome || platform !== 'linux') {
    return codexHome
  }
  return parseWslUncPath(codexHome)?.linuxPath ?? codexHome
}
