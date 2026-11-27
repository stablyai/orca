import { addAbortListener } from 'node:events'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { spawnProcess } from '@orca/process-host'
import { buildPosixStdoutFence } from '../../../shared/shell/launch/posix-stdout-fence'
import { buildWslExecArgs } from '../../../shared/shell/wsl/wsl-login-shell-command'
import type { OrcadRemoteContext } from '../../managed-server/install/orcad-remote-context'
import { execCommand } from '../../ssh/remote-exec/remote-exec-command'
import {
  listConfirmedRunningWslDistros,
  readWslDistroRunningState
} from '../discovery/wsl-background-distro-gate'
import { WSL_PROBE_TIMEOUT_MS, wslExeProcessSpec } from './wsl-exe-process'

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])
const HOLD_READY = 'ORCA_WSL_SSH_UPGRADE_READY'
const HOLD_SCRIPT = [
  '[ "$(cat /proc/sys/kernel/random/boot_id)" = "$1" ] || exit 1',
  '[ "$(readlink /proc/self/ns/pid)" = "$2" ] || exit 1',
  `printf '%s\\n' '${HOLD_READY}'`,
  'IFS= read -r unused || :'
].join('\n')

type WslSshUpgradeHold = { signal: AbortSignal; release(): void }

export async function holdWslForSshUpgrade(
  { target, connection, host }: OrcadRemoteContext,
  signal?: AbortSignal
): Promise<WslSshUpgradeHold | null> {
  if (
    process.platform !== 'win32' ||
    host.os !== 'linux' ||
    !LOOPBACK_HOSTS.has(target.host.trim().toLowerCase()) ||
    target.jumpHost ||
    target.proxyCommand
  ) {
    return null
  }

  const fence = buildPosixStdoutFence(
    'uname -r && cat /proc/sys/kernel/random/boot_id && readlink /proc/self/ns/pid',
    'SSH_WSL_UPGRADE'
  )
  const output = await execCommand(connection, fence.command, {
    wrapCommand: true,
    timeoutMs: WSL_PROBE_TIMEOUT_MS,
    signal
  }).catch(() => '')
  signal?.throwIfAborted()
  const [kernel, boot, namespace] = fence.readStdout(output)?.trim().split(/\r?\n/u) ?? []
  if (
    !kernel ||
    !/microsoft-standard|wsl2/iu.test(kernel) ||
    !boot ||
    !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu.test(boot) ||
    !namespace ||
    !/^pid:\[\d+\]$/u.test(namespace)
  ) {
    return null
  }

  // One WSL VM can share a boot ID across distros; the PID namespace distinguishes them.
  for (const distro of await listConfirmedRunningWslDistros()) {
    signal?.throwIfAborted()
    if ((await readWslDistroRunningState(distro)) !== 'running') {
      continue
    }
    signal?.throwIfAborted()
    const hold = await startWslSshUpgradeHold(distro, { boot, namespace }, signal)
    if (hold) {
      return hold
    }
  }
  signal?.throwIfAborted()
  return null
}

export function startWslSshUpgradeHold(
  distro: string,
  { boot, namespace }: { boot: string; namespace: string },
  signal?: AbortSignal
): Promise<WslSshUpgradeHold | null> {
  signal?.throwIfAborted()
  const args = buildWslExecArgs(distro, [
    '/bin/sh',
    '-c',
    HOLD_SCRIPT,
    'orca-ssh-upgrade',
    boot,
    namespace
  ])
  return waitForWslSshUpgradeHold(
    spawnProcess({
      ...wslExeProcessSpec(args, WSL_PROBE_TIMEOUT_MS, { ...process.env, WSL_UTF8: '1' }),
      stdio: 'pipe'
    }),
    signal
  )
}

export function waitForWslSshUpgradeHold(
  child: ChildProcessWithoutNullStreams,
  signal?: AbortSignal
): Promise<WslSshUpgradeHold | null> {
  const ready = Promise.withResolvers<WslSshUpgradeHold | null>()
  const lost = new AbortController()
  let acknowledged = false
  let released = false
  let closed = false
  let stdout = ''
  let abortListener: Disposable | undefined
  const startupTimer = setTimeout(unavailable, WSL_PROBE_TIMEOUT_MS)

  function release(): void {
    if (released) {
      return
    }
    released = true
    clearTimeout(startupTimer)
    abortListener?.[Symbol.dispose]()
    if (!closed) {
      child.stdin.end()
      const timer = setTimeout(() => child.kill(), 1_000)
      timer.unref()
      child.once('close', () => clearTimeout(timer))
    }
  }

  function unavailable(): void {
    if (acknowledged && !released) {
      lost.abort(new Error('WSL stopped responding during the Orca server update.'))
    }
    release()
    ready.resolve(null)
  }

  child.once('close', () => {
    closed = true
    unavailable()
  })
  child.once('exit', unavailable)
  child.on('error', unavailable)
  child.stdin.on('error', unavailable)
  child.stdout.on('error', unavailable)
  child.stderr.on('error', unavailable)
  child.stderr.resume()
  child.stdout.on('data', (chunk: Buffer) => {
    if (acknowledged || released) {
      return
    }
    stdout += chunk.toString()
    if (stdout.length > 4096) {
      unavailable()
    } else if (stdout.split(/\r?\n/u).slice(0, -1).includes(HOLD_READY)) {
      acknowledged = true
      clearTimeout(startupTimer)
      abortListener?.[Symbol.dispose]()
      ready.resolve({ signal: lost.signal, release })
    }
  })
  abortListener = signal ? addAbortListener(signal, unavailable) : undefined
  return ready.promise
}
