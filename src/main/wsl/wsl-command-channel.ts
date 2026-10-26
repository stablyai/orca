import { Duplex } from 'node:stream'
import type { PipedChildProcess } from '@orca/process-host/process-spec'
import type { RemoteCommandChannel } from '../managed-server/install/remote-install-transport'

/** Expose wsl.exe stdio as an SSH-style channel; exit reports status and close follows stdio teardown. */
export function wrapWslCommandProcess(child: PipedChildProcess): RemoteCommandChannel {
  // Only the child emits close, once after exit status, like ssh2.
  const duplex = new Duplex({
    emitClose: false,
    read() {
      child.stdout.resume()
    },
    write(chunk: Buffer, _encoding, done) {
      child.stdin.write(chunk, done)
    },
    final(done) {
      // EOF must reach the guest reader, not just this facade.
      child.stdin.end(done)
    }
  })
  let exitCode: number | null = null
  const onStdoutData = (chunk: Buffer): void => {
    // Backpressure: pause wsl.exe instead of buffering a slow consumer's lag in main.
    if (!duplex.push(chunk)) {
      child.stdout.pause()
    }
  }
  const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    exitCode = code
    duplex.emit('exit', code, signal)
  }
  const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
    cleanup()
    duplex.emit('close', exitCode ?? code, signal)
  }
  const onError = (error: Error): void => {
    duplex.destroy(error)
  }
  // A guest that exits before draining stdin is reported by its exit code, not EPIPE.
  const ignoreStreamError = (): void => {}
  const cleanup = (): void => {
    child.stdout.off('data', onStdoutData)
    child.off('exit', onExit)
    child.off('close', onClose)
    child.off('error', onError)
    child.stdout.off('error', onError)
  }
  child.stdout.on('data', onStdoutData)
  child.stdout.on('end', () => duplex.push(null))
  child.stdout.on('error', onError)
  child.stdin.on('error', ignoreStreamError)
  // Drain errors on unread stderr so they cannot crash main; consumers may add their own listeners.
  child.stderr.on('error', ignoreStreamError)
  child.on('exit', onExit)
  child.on('close', onClose)
  child.on('error', onError)
  const channel: RemoteCommandChannel = Object.assign(duplex, {
    stdin: child.stdin,
    stderr: child.stderr,
    close: () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill()
      }
    }
  })
  return channel
}
