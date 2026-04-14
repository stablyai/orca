/**
 * WSL file watcher using inotifywait.
 *
 * Why: @parcel/watcher uses ReadDirectoryChangesW which doesn't work across
 * the WSL network filesystem boundary (\\wsl.localhost\…).  Instead we spawn
 * `inotifywait` (from inotify-tools) inside the WSL distro where Linux-native
 * inotify works perfectly, and stream events back over stdout.
 */
import { spawn, type ChildProcess } from 'child_process'
import type { WebContents } from 'electron'
import type { Event as WatcherEvent } from '@parcel/watcher'
import type { FsChangedPayload } from '../../shared/types'
import { parseWslPath, toWindowsWslPath } from '../wsl'

// Re-use the same types / constants from the main watcher module.
// These are passed in via the WslWatcherDeps parameter to avoid circular imports.

export type WatcherSubscription = {
  unsubscribe(): Promise<void>
}

type DebouncedBatch = {
  events: WatcherEvent[]
  timer: ReturnType<typeof setTimeout> | null
  firstEventAt: number
}

export type WatchedRoot = {
  subscription: WatcherSubscription
  listeners: Map<number, WebContents>
  batch: DebouncedBatch
}

export type WslWatcherDeps = {
  ignoreDirs: string[]
  scheduleBatchFlush: (rootKey: string, root: WatchedRoot) => void
  watchedRoots: Map<string, WatchedRoot>
}

function buildInotifyExcludeRegex(ignoreDirs: string[]): string {
  // Why: inotifywait --exclude takes a POSIX extended regex.  Match any
  // path component that is one of the ignored directories.
  const escaped = ignoreDirs.map((d) => d.replace(/\./g, '\\.'))
  return `/(${escaped.join('|')})/`
}

export function createWslWatcher(
  rootKey: string,
  worktreePath: string,
  deps: WslWatcherDeps
): Promise<WatchedRoot> {
  const wslInfo = parseWslPath(worktreePath)
  if (!wslInfo) {
    return Promise.reject(new Error('Not a WSL path'))
  }

  const root: WatchedRoot = {
    subscription: null!,
    listeners: new Map(),
    batch: { events: [], timer: null, firstEventAt: 0 }
  }

  return new Promise((resolve, reject) => {
    const excludeRegex = buildInotifyExcludeRegex(deps.ignoreDirs)

    // Why: spawn inotifywait inside the WSL distro using wsl.exe with
    // bash -c.  Passing args directly via `wsl.exe -- inotifywait ...`
    // routes them through the default shell, which interprets regex
    // metacharacters (parens, pipes) as bash syntax.  Wrapping in
    // bash -c with single quotes prevents this.
    const escapedPath = wslInfo.linuxPath.replace(/'/g, "'\\''")
    const shellCmd = [
      'inotifywait -m -r',
      '-e create -e delete -e modify -e moved_to -e moved_from',
      `--format '%e %w%f'`,
      `--exclude '${excludeRegex}'`,
      `'${escapedPath}'`
    ].join(' ')

    const child: ChildProcess = spawn(
      'wsl.exe',
      ['-d', wslInfo.distro, '--', 'bash', '-c', shellCmd],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )

    let resolved = false
    let stdoutBuf = ''
    let stderrBuf = ''

    const processLine = (line: string): void => {
      if (!line.trim()) {
        return
      }
      const spaceIdx = line.indexOf(' ')
      if (spaceIdx === -1) {
        return
      }
      const eventFlags = line.slice(0, spaceIdx)
      const linuxPath = line.slice(spaceIdx + 1)

      // Convert inotifywait event flags to our event types
      let type: 'create' | 'update' | 'delete'
      if (eventFlags.includes('CREATE') || eventFlags.includes('MOVED_TO')) {
        type = 'create'
      } else if (eventFlags.includes('DELETE') || eventFlags.includes('MOVED_FROM')) {
        type = 'delete'
      } else if (eventFlags.includes('MODIFY') || eventFlags.includes('CLOSE_WRITE')) {
        type = 'update'
      } else {
        return
      }

      // Convert Linux path back to Windows UNC path so the renderer
      // can match it against its dirCache keys.
      const windowsPath = toWindowsWslPath(linuxPath, wslInfo.distro)

      root.batch.events.push({ type, path: windowsPath } as WatcherEvent)
      deps.scheduleBatchFlush(rootKey, root)
    }

    child.stdout!.setEncoding('utf-8')
    child.stdout!.on('data', (chunk: string) => {
      // Why: inotifywait prints "Watches established." to stderr when
      // ready.  But stdout data arriving means it's already watching.
      // Resolve on first stdout data if we haven't already.
      if (!resolved) {
        resolved = true
        resolve(root)
      }

      stdoutBuf += chunk
      const lines = stdoutBuf.split('\n')
      stdoutBuf = lines.pop() ?? ''
      for (const line of lines) {
        processLine(line)
      }
    })

    child.stderr!.setEncoding('utf-8')
    child.stderr!.on('data', (chunk: string) => {
      stderrBuf += chunk
      // Why: inotifywait prints "Watches established." to stderr when
      // the recursive watch setup is complete.  Use this as the ready
      // signal if no stdout data has arrived yet.
      if (!resolved && stderrBuf.includes('Watches established')) {
        resolved = true
        resolve(root)
      }
    })

    child.once('error', (err) => {
      console.error(`[filesystem-watcher] WSL inotifywait spawn error for ${rootKey}:`, err)
      if (!resolved) {
        resolved = true
        reject(new Error(`inotifywait spawn failed: ${err.message}`))
      }
    })

    child.once('close', (code) => {
      if (!resolved) {
        resolved = true
        // Why: if inotifywait exits before producing any output, it's
        // probably not installed.  Surface a clear message so the user
        // knows to install inotify-tools inside their WSL distro.
        const hint =
          stderrBuf.includes('not found') || code === 127
            ? 'inotifywait is not installed — run `sudo apt install inotify-tools` inside WSL'
            : `inotifywait exited with code ${code}`
        console.warn(`[filesystem-watcher] WSL watcher for ${rootKey}: ${hint}`)
        reject(new Error(hint))
        return
      }

      // Watcher died after it was already running — emit overflow so
      // the renderer does a full refresh, then clean up.
      const overflowPayload: FsChangedPayload = {
        worktreePath: rootKey,
        events: [{ kind: 'overflow', absolutePath: rootKey }]
      }
      for (const [, wc] of root.listeners) {
        if (!wc.isDestroyed()) {
          wc.send('fs:changed', overflowPayload)
        }
      }
      if (root.batch.timer) {
        clearTimeout(root.batch.timer)
      }
      deps.watchedRoots.delete(rootKey)
    })

    // Why: the subscription object wraps the child process kill so the
    // existing unsubscribe flow works identically for native and WSL.
    root.subscription = {
      unsubscribe: async () => {
        child.kill()
      }
    }
  })
}
