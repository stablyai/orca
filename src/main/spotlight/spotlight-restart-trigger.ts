// Agent-triggered server restart for Spotlight: `touch .orca/spotlight-restart`
// in the repo root asks Orca to restart the server terminal. File-based so any
// agent in any worktree can use it with zero CLI installation (the path is
// derivable from $ORCA_SPOTLIGHT_LOG).
import { watch, type FSWatcher } from 'node:fs'
import { rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { getLocalPtyProvider } from '../ipc/pty'

export const SPOTLIGHT_RESTART_TRIGGER_FILENAME = 'spotlight-restart'
// Delay between the interrupt and re-running the command: long enough for the
// server to release the prompt, short enough to feel immediate.
const RESTART_RERUN_DELAY_MS = 700

/** Minimal capture surface the restart needs — avoids a circular import on
 *  the mirror's full LogCapture type. */
export type RestartTarget = {
  ptyId: string
  restartInFlight: boolean
}

/** Interrupt the Spotlight terminal's foreground process, then re-run the last
 *  command via the shell's in-memory history (up-arrow + enter). Best-effort:
 *  a SIGINT-trapping TUI or a Windows cmd 'Terminate batch job (Y/N)?' prompt
 *  will consume the keys instead, so the caller logs 'requested', not 'done'.
 *  Returns false when a restart is already in flight. */
export function sendServerRestart(target: RestartTarget): boolean {
  if (target.restartInFlight) {
    return false
  }
  target.restartInFlight = true
  // history recall: up-arrow then enter. Interpreted by bash/zsh/fish and, on
  // Windows, PowerShell (PSReadLine) and cmd's doskey history alike.
  try {
    getLocalPtyProvider().write(target.ptyId, '\x03')
  } catch {
    target.restartInFlight = false
    return false
  }
  setTimeout(() => {
    try {
      getLocalPtyProvider().write(target.ptyId, '\x1b[A\r')
    } catch {
      // PTY died between interrupt and re-run; nothing else to do.
    } finally {
      target.restartInFlight = false
    }
  }, RESTART_RERUN_DELAY_MS)
  return true
}

/** Start watching .orca/ for the restart trigger file. Calls `onRestart` once
 *  per trigger (after deleting the file so a slow restart can't loop). Returns
 *  the watcher (close it on teardown) or null if watching failed.
 *
 *  `captureStartedAtMs` is when this capture began (before the async watcher
 *  setup). A leftover trigger OLDER than that is stale (agent touched it, then
 *  Orca closed/crashed) and is cleared without restarting; a trigger at-or-after
 *  it was written during this session — including in the setup gap before the
 *  watcher armed — so it is honored rather than silently deleted. */
export function watchRestartTrigger(
  orcaDir: string,
  onRestart: () => void,
  captureStartedAtMs: number
): FSWatcher | null {
  const triggerPath = path.join(orcaDir, SPOTLIGHT_RESTART_TRIGGER_FILENAME)
  const consumeTrigger = (): void => {
    void stat(triggerPath)
      .then(async () => {
        await rm(triggerPath, { force: true })
        onRestart()
      })
      .catch(() => {
        // Trigger absent — the event was for another file in .orca/.
      })
  }
  try {
    const watcher = watch(orcaDir, (_event, filename) => {
      if (filename === SPOTLIGHT_RESTART_TRIGGER_FILENAME) {
        consumeTrigger()
      }
    })
    // Reconcile any pre-existing trigger against the capture start time so the
    // arm-time cleanup can't race (and swallow) a legitimate touch written just
    // before the watcher armed.
    void stat(triggerPath)
      .then((stats) => {
        if (stats.mtimeMs < captureStartedAtMs) {
          return rm(triggerPath, { force: true })
        }
        consumeTrigger()
        return undefined
      })
      .catch(() => {
        // No leftover trigger — nothing to reconcile.
      })
    return watcher
  } catch {
    return null
  }
}
