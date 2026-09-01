import { posix, win32 } from 'node:path'
import type { AgentLaunchExecutionHostId } from '../../shared/agent-launch-host-contract'
import { parseWslUncPath } from '../../shared/wsl-paths'

function wslDistroFromExecutionHostId(
  targetExecutionHostId: AgentLaunchExecutionHostId
): string | null {
  if (!targetExecutionHostId.startsWith('wsl:')) {
    return null
  }
  try {
    return decodeURIComponent(targetExecutionHostId.slice('wsl:'.length)) || null
  } catch {
    return null
  }
}

export function transcriptPathConflictsWithWslTarget(
  transcriptPath: string,
  targetExecutionHostId: AgentLaunchExecutionHostId
): boolean {
  if (!targetExecutionHostId.startsWith('wsl:')) {
    return false
  }
  const targetDistro = wslDistroFromExecutionHostId(targetExecutionHostId)
  const unc = parseWslUncPath(transcriptPath.trim())
  return Boolean(unc && (!targetDistro || unc.distro.toLowerCase() !== targetDistro.toLowerCase()))
}

function usableAbsolutePath(value: string, platform: NodeJS.Platform): boolean {
  return (
    value.length > 0 &&
    !value.includes('\0') &&
    (platform === 'win32' ? win32.isAbsolute(value) : posix.isAbsolute(value))
  )
}

/** Canonical host-private transcript identity used only by correlation indexes. */
export function canonicalAgentSessionTranscriptIdentity(args: {
  transcriptPath: string
  targetExecutionHostId: AgentLaunchExecutionHostId
  targetPlatform: NodeJS.Platform
}): string | null {
  const raw = args.transcriptPath.trim()
  if (!raw) {
    return null
  }

  if (args.targetExecutionHostId.startsWith('wsl:')) {
    const targetDistro = wslDistroFromExecutionHostId(args.targetExecutionHostId)
    if (!targetDistro) {
      return null
    }
    const unc = parseWslUncPath(raw)
    if (unc && unc.distro.toLowerCase() !== targetDistro.toLowerCase()) {
      return null
    }
    const linuxPath = unc?.linuxPath ?? raw
    if (!usableAbsolutePath(linuxPath, 'linux')) {
      return null
    }
    return `posix:${posix.normalize(linuxPath)}`
  }

  if (!usableAbsolutePath(raw, args.targetPlatform)) {
    return null
  }
  return args.targetPlatform === 'win32'
    ? `windows:${win32.normalize(raw).replace(/\\/g, '/').toLowerCase()}`
    : `posix:${posix.normalize(raw)}`
}
