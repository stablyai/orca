import { once } from 'node:events'
import { spawnProcess } from '@orca/process-host'
import type { PipedProcessSpawner } from '@orca/process-host/process-spec'
import { buildWslExecArgs } from '../../shared/wsl-login-shell-command'
import { commandLineLength, MAX_COMMAND_LINE_CHARS } from '../../shared/windows-command-line-budget'
import type { OrcadHostTransport } from '../ssh/orcad-host-transport'
import type { RemoteCommandChannel } from '../managed-server/install/remote-install-transport'
import {
  createSshOperationAbortError,
  type SshExecOptions
} from '../ssh/connection/ssh-exec-options'
import { writeStringViaExecStdin } from '../ssh/ssh-exec-stdin-file-transfer'
import { resolveWslInteropSpawnCwd } from '../wsl-interop-spawn-directory'
import { wrapWslCommandProcess } from './wsl-command-channel'
import { WSL_COMMAND_LOOP_ARGV0, WSL_COMMAND_LOOP_SCRIPT } from './wsl-command-loop'
import { createWslCommandLoopPool } from './wsl-command-loop-pool'
import { uploadDirectoryIntoWsl, wslGuestSourcePath } from './wsl-directory-upload'
import { resolveWslExecutablePath } from './wsl-executable-path'
import { readWslDistroRegistryIdShared } from './wsl-distro-registry-id'
import { ORCAD_WSL_DISTRO_GUID_ENV } from '../orcad/orcad-migration-wsl-destination'
import type { WslOrcadHostTarget } from './wsl-orcad-host-target'

export type WslOrcadHostTransport = OrcadHostTransport & {
  getTarget(): WslOrcadHostTarget
  /** Ends the idle command loops now instead of after their idle timeout. */
  dispose(): void
}

type WslOrcadHostTransportOptions = {
  target: WslOrcadHostTarget
  /** Test seam; production spawns through process-host. */
  spawn?: PipedProcessSpawner
  /** Default tar beat /mnt copy on win-lowspec (0.97s vs 1.6s/20MB); guest-mount opts into direct reads when visible. */
  uploadSource?: 'tar' | 'guest-mount'
  /** Test seam: false runs every command on its own wsl.exe. */
  commandLoops?: boolean
  /** Test seam; production shares the deploy's own registry read (no extra reg.exe). */
  readDistroRegistryId?: (distro: string) => Promise<string | null>
}

/** Reuse loops for stdin-free probes; stdin consumers get dedicated wsl.exe children. WSL is a Linux host without SFTP, so transfers use exec. */
export function createWslOrcadHostTransport(
  options: WslOrcadHostTransportOptions
): WslOrcadHostTransport {
  const spawn = options.spawn ?? spawnProcess
  const { target } = options
  const spawnWsl = (shellArgs: string[]) => {
    const program = resolveWslExecutablePath()
    const args = buildWslExecArgs(target.distro, shellArgs)
    if (commandLineLength([program, ...args]) > MAX_COMMAND_LINE_CHARS) {
      throw new Error('WSL command exceeds the Windows command-line limit')
    }
    return spawn({
      program,
      args,
      cwd: resolveWslInteropSpawnCwd(),
      // Request UTF-8 for wsl.exe's own errors; default is UTF-16LE.
      env: { ...process.env, WSL_UTF8: '1' }
    })
  }
  const loops =
    options.commandLoops === false
      ? null
      : createWslCommandLoopPool({
          spawnLoop: (marker) =>
            spawnWsl(['sh', '-c', WSL_COMMAND_LOOP_SCRIPT, WSL_COMMAND_LOOP_ARGV0, marker])
        })
  const transport: WslOrcadHostTransport = {
    // wrapCommand is SSH-only; WSL starts sh directly without a login shell.
    async exec(command: string, execOptions?: SshExecOptions): Promise<RemoteCommandChannel> {
      if (execOptions?.signal?.aborted) {
        throw createSshOperationAbortError()
      }
      const child = spawnWsl(['sh', '-c', command])
      const channel = wrapWslCommandProcess(child)
      // Reject spawn failure while opening the channel, matching SSH, rather than as a later stream error.
      const spawnError = (error: Error): void => {
        channel.destroy(error)
      }
      channel.on('error', spawnError)
      try {
        await once(child, 'spawn')
      } finally {
        channel.off('error', spawnError)
      }
      return channel
    },
    async execWithClosedStdin(command, execOptions) {
      return (
        (await loops?.run(command, execOptions?.signal)) ?? transport.exec(command, execOptions)
      )
    },
    dispose: () => loops?.dispose(),
    // Without systemd, nohup children die with wsl.exe; launch orcad in a new session.
    orcadLaunchDetach: 'setsid',
    // D1b-2: bind launches to the registration the guest cannot read itself.
    orcadLaunchEnv: async () => {
      const id = await (options.readDistroRegistryId ?? readWslDistroRegistryIdShared)(
        target.distro
      )
      return id ? [[ORCAD_WSL_DISTRO_GUID_ENV, id]] : []
    },
    usesSystemSshTransport: () => false,
    // One transport, one wsl.exe lane: nothing underneath is ever replaced.
    getConnectGeneration: () => 0,
    getTarget: () => target,
    writeFile: (remotePath, contents, fileOptions) =>
      writeStringViaExecStdin(transport, remotePath, contents, { signal: fileOptions?.signal }),
    uploadDirectory: (localDir, remoteDir, fileOptions) =>
      uploadDirectoryIntoWsl(
        transport,
        localDir,
        options.uploadSource === 'guest-mount' ? wslGuestSourcePath(localDir, target.distro) : null,
        remoteDir,
        { signal: fileOptions?.signal }
      )
  }
  return transport
}
