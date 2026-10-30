import type { ClientChannel } from 'ssh2'
import type { SshTarget } from '../../../shared/ssh-types'
import { isOpenSshConfigBackedTarget } from '../system-transport/system-ssh-args'
import type { SshResolvedConfig } from '../config/ssh-g-config-resolution'
import { createCancelledConnectAttemptError } from '../ssh-connect-attempt-cancellation'
import { CONNECT_TIMEOUT_MS } from './ssh-connection-timing'

export function cloneResolvedConfig(config: SshResolvedConfig | null): SshResolvedConfig | null {
  if (!config) {
    return null
  }
  // Clone array fields separately so one connection cannot mutate another's consulted-source list.
  return {
    ...config,
    identityFile: [...config.identityFile],
    userKnownHostsFiles: [...config.userKnownHostsFiles],
    globalKnownHostsFiles: [...config.globalKnownHostsFiles]
  }
}

function isGitHubRestrictedShellProbeSuccess(
  target: SshTarget,
  resolvedConfig: SshResolvedConfig | null,
  code: number | null,
  stderr: string
): boolean {
  if (code !== 1) {
    return false
  }

  const effectiveUser = (
    isOpenSshConfigBackedTarget(target) && resolvedConfig
      ? resolvedConfig.user?.trim() || target.username?.trim()
      : target.username?.trim() || resolvedConfig?.user?.trim()
  )?.toLowerCase()
  if (effectiveUser !== 'git') {
    return false
  }

  // GitHub appends git:// advisory lines after the invalid-command line (issue #6988), so match the first line only.
  const firstLine = stderr.split('\n', 1)[0]?.trim()
  if (firstLine !== 'Invalid command: echo ORCA-SYSTEM-SSH-OK') {
    return false
  }

  const resolvedHost = resolvedConfig?.hostname?.trim()
  const hostCandidates = resolvedHost ? [resolvedHost] : [target.host, target.configHost]

  return hostCandidates.some((host) => {
    const normalizedHost = host?.trim().toLowerCase()
    return normalizedHost === 'github.com' || normalizedHost === 'ssh.github.com'
  })
}

/** What the probe reads from its connection; getters so each read sees the live attempt. */
type SystemSshProbeHost = {
  target: SshTarget
  resolvedConfig: () => SshResolvedConfig | null
  isCurrentAttempt: () => boolean
  /** Runs before the probe resolves, so the connection is published as connected first. */
  onConnected: () => void
  untrackChannel: (channel: ClientChannel) => void
}

/** Settles once the probe channel proves the system ssh binary reached the host. */
export function waitForSystemSshProbe(
  channel: ClientChannel,
  host: SystemSshProbeHost
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const cleanup = (): void => {
      clearTimeout(timeout)
      channel.off('data', onStdoutData)
      channel.stderr.off('data', onStderrData)
      channel.off('error', onError)
      channel.off('close', onClose)
      host.untrackChannel(channel)
    }
    const settle = (callback: () => void): void => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      callback()
    }
    const onStdoutData = (data: Buffer): void => {
      stdout += data.toString('utf-8')
    }
    const onStderrData = (data: Buffer): void => {
      stderr += data.toString('utf-8')
    }
    const onError = (err: Error): void => {
      settle(() => reject(err))
    }
    const onClose = (code: number | null): void => {
      settle(() => {
        if (!host.isCurrentAttempt()) {
          reject(createCancelledConnectAttemptError())
          return
        }
        if (
          (code === 0 && stdout.includes('ORCA-SYSTEM-SSH-OK')) ||
          isGitHubRestrictedShellProbeSuccess(host.target, host.resolvedConfig(), code, stderr)
        ) {
          host.onConnected()
          resolve()
          return
        }
        reject(
          new Error(
            `System SSH probe failed${code != null ? ` (exit ${code})` : ''}.${stderr ? ` stderr: ${stderr.trim()}` : ''}`
          )
        )
      })
    }
    const timeout = setTimeout(() => {
      settle(() => {
        channel.close()
        reject(new Error('System SSH connection timed out'))
      })
    }, CONNECT_TIMEOUT_MS)

    channel.on('data', onStdoutData)
    channel.stderr.on('data', onStderrData)
    channel.on('error', onError)
    channel.on('close', onClose)
  })
}
