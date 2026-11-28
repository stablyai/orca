import { addAbortListener } from 'node:events'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { spawnProcess } from '@orca/process-host'
import { windowsSystem32Binary } from '@orca/process-host/windows-system-binary'
import { buildPosixStdoutFence } from '../../../shared/shell/launch/posix-stdout-fence'
import { buildWslExecArgs } from '../../../shared/shell/wsl/wsl-login-shell-command'
import type { OrcadRemoteContext } from '../../managed-server/install/orcad-remote-context'
import { execCommand } from '../../ssh/remote-exec/remote-exec-command'
import {
  listConfirmedRunningWslDistros,
  readWslDistroRunningState
} from '../discovery/wsl-background-distro-gate'
import { WSL_PROBE_TIMEOUT_MS } from './wsl-exe-process'
import { resolveWslInteropSpawnCwdAsync } from './wsl-interop-spawn-directory'

const LOOPBACK_HOSTS = new Set(['localhost', '::1', '[::1]'])
const HOLD_READY = 'ORCA_WSL_SSH_UPGRADE_READY'
const HOLD_SCRIPT = [
  '[ "$(cat /proc/sys/kernel/random/boot_id)" = "$1" ] || exit 1',
  '[ "$(readlink /proc/self/ns/pid)" = "$2" ] || exit 1',
  `printf '%s\\n' '${HOLD_READY}'`,
  'IFS= read -r unused || :'
].join('\n')

type WslSshUpgradeHold = { release(): void }

/** ssh-config imports store the resolved HostName in `host`, so aliases to loopback match too. */
export function isLoopbackSshHost(host: string): boolean {
  const normalized = host.trim().toLowerCase()
  return LOOPBACK_HOSTS.has(normalized) || /^127(?:\.\d{1,3}){3}$/u.test(normalized)
}

/** Best effort: only the caller's abort fails the update; any other hold failure falls back to no hold. */
export async function holdWslForSshUpgrade(
  context: OrcadRemoteContext,
  signal?: AbortSignal
): Promise<WslSshUpgradeHold | null> {
  try {
    return await tryHoldWslForSshUpgrade(context, signal)
  } catch (error) {
    signal?.throwIfAborted()
    console.warn('[wsl] could not keep WSL running for the Orca server update', error)
    return null
  }
}

async function tryHoldWslForSshUpgrade(
  { target, connection, host }: OrcadRemoteContext,
  signal?: AbortSignal
): Promise<WslSshUpgradeHold | null> {
  if (
    process.platform !== 'win32' ||
    host.os !== 'linux' ||
    !isLoopbackSshHost(target.host) ||
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

export async function startWslSshUpgradeHold(
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
  const cwd = await resolveWslInteropSpawnCwdAsync()
  signal?.throwIfAborted()
  // No spawn timeoutMs: this child must outlive the probe; waitForWslSshUpgradeHold bounds startup.
  const child = spawnProcess({
    program: windowsSystem32Binary('wsl.exe'),
    args,
    env: { ...process.env, WSL_UTF8: '1' },
    cwd,
    stdio: 'pipe'
  })
  return await waitForWslSshUpgradeHold(child, signal)
}

export function waitForWslSshUpgradeHold(
  child: ChildProcessWithoutNullStreams,
  signal?: AbortSignal
): Promise<WslSshUpgradeHold | null> {
  const ready = Promise.withResolvers<WslSshUpgradeHold | null>()
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
      // The SSH update may still be healthy; only the caller's signal (user cancel) aborts it.
      console.warn(
        '[wsl] keep-alive for the Orca server update exited early; continuing without it'
      )
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
      ready.resolve({ release })
    }
  })
  abortListener = signal ? addAbortListener(signal, unavailable) : undefined
  return ready.promise
}
