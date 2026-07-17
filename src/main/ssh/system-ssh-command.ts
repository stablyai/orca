import { spawn, type ChildProcess } from 'node:child_process'
import { Duplex, Writable } from 'node:stream'
import type { ClientChannel } from 'ssh2'
import type { SshTarget } from '../../shared/ssh-types'
import { wrapRemoteCommandForPosixShell, type SshExecOptions } from './ssh-connection-utils'
import { buildSshArgs, type SystemSshBuildArgsOptions } from './system-ssh-args'
import { findSystemSsh } from './system-ssh-binary'

export type SystemSshProcess = {
  stdin: NodeJS.WritableStream
  stdout: NodeJS.ReadableStream
  stderr: NodeJS.ReadableStream
  kill: () => void
  onExit: (cb: (code: number | null) => void) => void
  pid: number | undefined
}

export type SystemSshCommandChannel = ClientChannel & {
  _process?: ChildProcess
  _systemSshLaunchMode?: SystemSshCommandLaunchMode
}

export type SystemSshCommandLaunchMode = 'direct' | 'windows-no-input-launcher'

export type SystemSshCommandOptions = SshExecOptions &
  SystemSshBuildArgsOptions & {
    windowsNoInputLauncherPath?: string
  }

/**
 * Spawn a system ssh process connecting to the given target.
 * Used when ssh2 cannot handle the auth method (FIDO2, ControlMaster).
 *
 * The returned process's stdin/stdout are used as the transport for
 * the relay's JSON-RPC protocol, exactly like an ssh2 channel.
 */
export function spawnSystemSsh(
  target: SshTarget,
  options?: SystemSshBuildArgsOptions
): SystemSshProcess {
  const sshPath = findSystemSsh()
  if (!sshPath) {
    throw new Error(
      'No system ssh binary found. Install OpenSSH to use FIDO2 keys or ControlMaster.'
    )
  }

  const args = buildSshArgs(target, options)
  const proc = spawn(sshPath, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  })

  return wrapChildProcess(proc)
}

export function spawnSystemSshCommand(
  target: SshTarget,
  command: string,
  options?: SystemSshCommandOptions
): SystemSshCommandChannel {
  const sshPath = findSystemSsh()
  if (!sshPath) {
    throw new Error(
      'No system ssh binary found. Install OpenSSH to use ProxyUseFdpass, FIDO2 keys, or ControlMaster.'
    )
  }

  const remoteCommand =
    options?.wrapCommand === false ? command : wrapRemoteCommandForPosixShell(command)
  const noInput = options?.noInput === true
  const windowsNoInputLauncherPath =
    noInput && process.platform === 'win32' ? options?.windowsNoInputLauncherPath : undefined
  const sshArgs = buildSshArgs(
    target,
    windowsNoInputLauncherPath ? { ...options, noInput: false } : options
  )
  const executable = windowsNoInputLauncherPath ?? sshPath
  const args = windowsNoInputLauncherPath
    ? [sshPath, ...sshArgs, remoteCommand]
    : [...sshArgs, remoteCommand]
  const stdinMode =
    windowsNoInputLauncherPath || (noInput && process.platform !== 'win32') ? 'ignore' : 'pipe'
  const proc = spawn(executable, args, {
    // Why: Win32-OpenSSH can hang when stdin is mapped to NUL; give it a
    // proven launcher only when its verified path is explicitly supplied.
    stdio: [stdinMode, 'pipe', 'pipe'],
    windowsHide: true
  })
  if (noInput && process.platform === 'win32' && !windowsNoInputLauncherPath) {
    proc.stdin?.destroy()
  }
  return wrapCommandProcess(
    proc,
    !noInput,
    windowsNoInputLauncherPath ? 'windows-no-input-launcher' : 'direct'
  )
}

function wrapChildProcess(proc: ChildProcess): SystemSshProcess {
  return {
    stdin: proc.stdin!,
    stdout: proc.stdout!,
    stderr: proc.stderr!,
    pid: proc.pid,
    kill: () => {
      try {
        proc.kill('SIGTERM')
      } catch {
        // Process may already be dead
      }
    },
    onExit: (cb) => {
      proc.on('exit', (code) => cb(code))
    }
  }
}

function wrapCommandProcess(
  proc: ChildProcess,
  acceptsInput: boolean,
  launchMode: SystemSshCommandLaunchMode
): SystemSshCommandChannel {
  const duplex = new Duplex({
    read() {
      proc.stdout?.resume()
    },
    write(chunk, encoding, cb) {
      if (!acceptsInput || !proc.stdin) {
        cb(new Error('System SSH command does not accept stdin'))
        return
      }
      proc.stdin.write(chunk, encoding, cb)
    }
  })
  const channel = duplex as unknown as SystemSshCommandChannel

  const mutableChannel = channel as unknown as {
    stdin: NodeJS.WritableStream
    stderr: NodeJS.ReadableStream
    _process?: ChildProcess
    _systemSshLaunchMode?: SystemSshCommandLaunchMode
    close: () => void
  }
  mutableChannel.stdin =
    (acceptsInput ? proc.stdin : null) ??
    new Writable({
      // Why: ending a no-input facade must not half-close the readable command
      // channel before the child reports its exit status.
      write(_chunk, _encoding, cb) {
        cb(new Error('System SSH command does not accept stdin'))
      }
    })
  mutableChannel.stderr = proc.stderr!
  mutableChannel._process = proc
  mutableChannel._systemSshLaunchMode = launchMode
  mutableChannel.close = () => {
    try {
      proc.kill('SIGTERM')
    } catch {
      // Process may already be dead
    }
  }

  const cleanupProcessListeners = (): void => {
    proc.stdout!.off('data', onStdoutData)
    proc.stdout!.off('end', onStdoutEnd)
    proc.off('exit', onExit)
    proc.off('close', onClose)
    proc.off('error', onProcessError)
    if (acceptsInput) {
      proc.stdin?.off('error', onStreamError)
    }
    proc.stdout!.off('error', onStreamError)
  }
  const fail = (err: Error): void => {
    cleanupProcessListeners()
    duplex.destroy(err)
  }
  const onStdoutData = (data: Buffer): void => {
    // Why: file downloads can outpace the local destination; pause OpenSSH
    // instead of buffering the producer-consumer lag in the main process.
    if (!duplex.push(data)) {
      proc.stdout!.pause()
    }
  }
  const onStdoutEnd = (): void => {
    duplex.push(null)
  }
  const onExit = (code: number | null, signal?: NodeJS.Signals | null): void => {
    channel.emit('exit', code, signal)
  }
  const onClose = (code: number | null, signal?: NodeJS.Signals | null): void => {
    cleanupProcessListeners()
    channel.emit('close', code, signal)
  }
  const onProcessError = (err: Error): void => {
    fail(err)
  }
  const onStreamError = (err: Error): void => {
    fail(err)
  }

  proc.stdout!.on('data', onStdoutData)
  proc.stdout!.on('end', onStdoutEnd)
  proc.on('exit', onExit)
  proc.on('close', onClose)
  proc.on('error', onProcessError)
  if (acceptsInput) {
    proc.stdin?.on('error', onStreamError)
  }
  proc.stdout!.on('error', onStreamError)

  return channel
}
