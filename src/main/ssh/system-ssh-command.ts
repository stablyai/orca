import { spawn, type ChildProcess } from 'node:child_process'
import { Duplex } from 'node:stream'
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
}

type SystemSshCommandOptions = SshExecOptions & SystemSshBuildArgsOptions

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
  const proc = spawn(sshPath, [...buildSshArgs(target, options), remoteCommand], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  })
  return wrapCommandProcess(proc)
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

function wrapCommandProcess(proc: ChildProcess): SystemSshCommandChannel {
  const duplex = new Duplex({
    read() {
      proc.stdout?.resume()
    },
    write(chunk, encoding, cb) {
      proc.stdin!.write(chunk, encoding, cb)
    }
  })
  const channel = duplex as unknown as SystemSshCommandChannel

  const mutableChannel = channel as unknown as {
    stdin: NodeJS.WritableStream
    stderr: NodeJS.ReadableStream
    _process?: ChildProcess
    close: () => void
  }
  mutableChannel.stdin = proc.stdin!
  mutableChannel.stderr = proc.stderr!
  mutableChannel._process = proc
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
    proc.stdin!.off('error', onStreamError)
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
  proc.stdin!.on('error', onStreamError)
  proc.stdout!.on('error', onStreamError)

  return channel
}
