import { runProcess } from '@orca/process-host'
import { getDaemonPidPath, getDaemonSocketPath, getDaemonTokenPath } from './daemon-spawner'
import { PROTOCOL_VERSION } from './daemon-protocol-version'
import { macDaemonJobLabel } from './macos-daemon-job-label'

export type RetiredMacDaemonJob = {
  service: string
  protocolVersion: number
  pid: number
  launchNonce: string
  socketPath: string
  pidPath: string
}

async function launchctl(args: string[]): Promise<string | null> {
  const result = await runProcess({
    program: '/bin/launchctl',
    args,
    timeoutMs: 3_000,
    maxOutputBytes: 128 * 1024
  })
  if (
    args[0] === 'print' &&
    result.code === 113 &&
    !result.timedOut &&
    !result.outputTruncated &&
    result.stderr.includes('Could not find service') &&
    !/Operation not permitted|Permission denied/i.test(result.stderr)
  ) {
    return null
  }
  if (result.code !== 0 || result.timedOut || result.outputTruncated) {
    throw new Error('Could not inspect macOS terminal services for restart recovery')
  }
  return result.stdout
}

/** Reads only exact profile labels; newer protocols remain owned by their newer app. */
export async function listMacDaemonJobVersions(userDataPath: string): Promise<number[]> {
  const prefix = macDaemonJobLabel(userDataPath, 0).slice(0, -1)
  const versions = new Set<number>()
  for (const line of (await launchctl(['list']))?.split('\n') ?? []) {
    const label = line.trim().split(/\s+/)[2]
    if (!label?.startsWith(prefix)) {
      continue
    }
    const suffix = label.slice(prefix.length)
    const version = Number(suffix)
    if (/^[1-9]\d*$/.test(suffix) && Number.isSafeInteger(version) && version <= PROTOCOL_VERSION) {
      versions.add(version)
    }
  }
  if (versions.size > 32) {
    throw new Error('Too many macOS terminal services to recover safely')
  }
  return [...versions]
}

/** launchctl's structured argument block provides exact endpoint ownership, without parsing argv text. */
export async function readMacDaemonRecoveryJob(
  userDataPath: string,
  runtimeDir: string,
  protocolVersion: number
): Promise<RetiredMacDaemonJob | null> {
  if (
    !Number.isSafeInteger(protocolVersion) ||
    protocolVersion < 1 ||
    protocolVersion > PROTOCOL_VERSION
  ) {
    return null
  }
  const service = `gui/${process.getuid?.()}/${macDaemonJobLabel(userDataPath, protocolVersion)}`
  const output = await launchctl(['print', service])
  if (!output || !/^\tstate = running$/m.test(output)) {
    return null
  }
  const pid = Number(/^\tpid = (\d+)$/m.exec(output)?.[1])
  const block = /^\targuments = \{\n((?:\t\t[^\n]*\n)+)\t\}$/m.exec(output)?.[1]
  const args =
    block
      ?.split('\n')
      .filter(Boolean)
      .map((line) => line.slice(2)) ?? []
  const argument = (flag: string): string | undefined =>
    args.filter((value) => value === flag).length === 1 ? args[args.indexOf(flag) + 1] : undefined
  const socketPath = getDaemonSocketPath(runtimeDir, protocolVersion)
  const pidPath = getDaemonPidPath(runtimeDir, protocolVersion)
  const launchNonce = argument('--launch-nonce')
  if (
    !Number.isSafeInteger(pid) ||
    pid <= 1 ||
    !launchNonce ||
    launchNonce.startsWith('--') ||
    !args.includes('--login-session-watch') ||
    argument('--socket') !== socketPath ||
    argument('--token') !== getDaemonTokenPath(runtimeDir, protocolVersion) ||
    argument('--pid-record') !== pidPath
  ) {
    return null
  }
  return { service, protocolVersion, pid, launchNonce, socketPath, pidPath }
}
