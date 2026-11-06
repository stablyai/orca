import { spawnProcess } from '@orca/process-host'
import { resolveMacKeyboardHelperPath } from '../ipc/macos-keyboard-layout-snapshot'
import type { HoldQuitWatchEvent } from './hold-quit-gesture'

export function watchMacQuitChord(
  code: string,
  emit: (event: HoldQuitWatchEvent) => void
): () => void {
  const path = resolveMacKeyboardHelperPath()
  if (!path) {
    emit('unavailable')
    return () => {}
  }
  let child: ReturnType<typeof spawnProcess>
  try {
    child = spawnProcess({ program: path, args: ['--watch-quit-chord', code], stdio: 'pipe' })
  } catch {
    emit('unavailable')
    return () => {}
  }
  let settled = false
  let buffer = ''
  const stop = (): void => {
    settled = true
    clearTimeout(timer)
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
    }
  }
  const finish = (event: HoldQuitWatchEvent): void => {
    if (settled) {
      return
    }
    stop()
    emit(event)
  }
  const timer = setTimeout(() => finish('unavailable'), 3000)
  child.stdout?.on('data', (chunk: Buffer) => {
    if (settled) {
      return
    }
    buffer += chunk.toString('utf8')
    if (buffer.length > 1024) {
      finish('unavailable')
      return
    }
    let newline = buffer.indexOf('\n')
    while (newline !== -1 && !settled) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      let event: unknown
      try {
        event = JSON.parse(line)
      } catch {
        finish('unavailable')
        return
      }
      if (!event || typeof event !== 'object' || !('state' in event)) {
        finish('unavailable')
        return
      }
      if (event.state === 'watching') {
        emit('watching')
      } else if (event.state === 'held' || event.state === 'released') {
        finish(event.state)
      } else {
        finish('unavailable')
        return
      }
      newline = buffer.indexOf('\n')
    }
  })
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    stream?.on('error', () => finish('unavailable'))
  }
  child.on('error', () => finish('unavailable'))
  child.on('close', () => finish('unavailable'))
  child.stdin?.end()
  return stop
}
