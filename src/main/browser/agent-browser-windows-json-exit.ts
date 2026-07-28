import type { ChildProcess } from 'node:child_process'
import { platform } from 'node:os'

const MAX_CAPTURE_BYTES = 50 * 1024 * 1024

// Windows daemons can inherit stdout, preventing execFile's close callback after the command exits.
export function captureAgentBrowserJsonAtProcessExit(
  child: ChildProcess,
  onComplete: (stdout: string) => void
): () => void {
  if (platform() !== 'win32' || !child.stdout) {
    return () => {}
  }

  const chunks: Buffer[] = []
  let bytes = 0
  let exited = false
  let detached = false
  let pendingCheck: NodeJS.Immediate | null = null

  const detach = (): void => {
    if (detached) {
      return
    }
    detached = true
    if (pendingCheck) {
      clearImmediate(pendingCheck)
      pendingCheck = null
    }
    child.stdout?.off('data', onData)
    child.off('exit', onExit)
  }

  const checkComplete = (): void => {
    pendingCheck = null
    if (!exited || detached) {
      return
    }
    const stdout = Buffer.concat(chunks, bytes).toString('utf8')
    try {
      JSON.parse(stdout)
    } catch {
      return
    }
    detach()
    onComplete(stdout)
  }

  const scheduleCheck = (): void => {
    if (!pendingCheck && !detached) {
      pendingCheck = setImmediate(checkComplete)
    }
  }

  function onData(chunk: Buffer | string): void {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.byteLength
    if (bytes > MAX_CAPTURE_BYTES) {
      detach()
      return
    }
    chunks.push(buffer)
    if (exited) {
      scheduleCheck()
    }
  }

  function onExit(): void {
    exited = true
    scheduleCheck()
  }

  child.stdout.on('data', onData)
  child.once('exit', onExit)
  return detach
}
