import type { SshConnection } from './ssh-connection'
import { createSshOperationAbortError } from './ssh-connection-utils'
import { execCommand } from './ssh-relay-deploy-helpers'
import { isSshSessionLimitError } from './ssh-session-limit-error'

export type RemoteNodeResolutionOptions = {
  rethrowSessionLimitErrors?: boolean
  signal?: AbortSignal
}

const NODE_PACKAGE_MANAGER_PROBE_TIMEOUT_MS = 8_000

const NODE_PACKAGE_MANAGER_HINTS: readonly { bin: string; label: string; install: string }[] = [
  { bin: 'apt-get', label: 'Debian/Ubuntu', install: 'sudo apt-get install -y nodejs npm' },
  { bin: 'dnf', label: 'Fedora/RHEL', install: 'sudo dnf install -y nodejs npm' },
  { bin: 'yum', label: 'RHEL/CentOS', install: 'sudo yum install -y nodejs npm' },
  { bin: 'pacman', label: 'Arch', install: 'sudo pacman -S --needed nodejs npm' },
  { bin: 'apk', label: 'Alpine', install: 'sudo apk add nodejs npm' },
  { bin: 'zypper', label: 'openSUSE', install: 'sudo zypper install -y nodejs npm' },
  { bin: 'brew', label: 'macOS/Homebrew', install: 'brew install node' }
]

export async function buildPosixNodeInstallGuidance(
  conn: SshConnection,
  options?: RemoteNodeResolutionOptions
): Promise<string> {
  const detectedBin = await detectPackageManager(conn, options)
  return formatNodeInstallHints(detectedBin)
}

async function detectPackageManager(
  conn: SshConnection,
  options?: RemoteNodeResolutionOptions
): Promise<string | null> {
  throwIfAborted(options)
  const bins = NODE_PACKAGE_MANAGER_HINTS.map((hint) => hint.bin).join(' ')
  try {
    const output = await execCommand(
      conn,
      `for p in ${bins}; do if command -v "$p" >/dev/null 2>&1; then echo "$p"; break; fi; done`,
      commandOptions(options)
    )
    const detected = output.trim().split('\n')[0]
    return NODE_PACKAGE_MANAGER_HINTS.some((hint) => hint.bin === detected) ? detected : null
  } catch (err) {
    if (options?.rethrowSessionLimitErrors && isSshSessionLimitError(err)) {
      throw err
    }
    throwIfAborted(options)
    return null
  }
}

function formatNodeInstallHints(detectedBin: string | null): string {
  const tailored = detectedBin
    ? NODE_PACKAGE_MANAGER_HINTS.find((hint) => hint.bin === detectedBin)
    : null
  const lines = [
    'Node.js not found on remote host. Orca relay requires Node.js 18+ and npm.',
    '',
    'Install Node.js 18+ with npm on the remote host, then reconnect:'
  ]
  if (tailored) {
    lines.push(`  ${tailored.label}: ${tailored.install}`)
  } else {
    for (const hint of NODE_PACKAGE_MANAGER_HINTS) {
      lines.push(`  ${hint.label}: ${hint.install}`)
    }
  }
  lines.push(
    '',
    'Verify the remote runtime before reconnecting:',
    '  node --version  # must be v18 or newer',
    '  npm --version',
    '',
    'If your distro package is older than Node 18, install an LTS release from https://nodejs.org/.'
  )
  return lines.join('\n')
}

function commandOptions(options?: RemoteNodeResolutionOptions): {
  timeoutMs: number
  signal?: AbortSignal
} {
  const base = { timeoutMs: NODE_PACKAGE_MANAGER_PROBE_TIMEOUT_MS }
  return options?.signal ? { ...base, signal: options.signal } : base
}

function throwIfAborted(options?: RemoteNodeResolutionOptions): void {
  if (options?.signal?.aborted) {
    throw createSshOperationAbortError()
  }
}
