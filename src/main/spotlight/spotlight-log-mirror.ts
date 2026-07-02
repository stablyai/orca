// Mirrors the Spotlight terminal's PTY output into <repoRoot>/.orca/spotlight.log
// so agents running in any worktree can read the dev server's logs (the server
// runs once, at the repo root, inside the Spotlight terminal tab).
import { watch, type FSWatcher } from 'node:fs'
import { appendFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { SPOTLIGHT_LOG_RELATIVE_PATH } from '../../shared/spotlight'
import { gitExecFileAsync } from '../git/runner'
import { getLocalPtyProvider, onLocalPtyProviderChanged } from '../ipc/pty'

// Keep the log useful for `tail`/`grep` without growing unbounded: once it
// passes MAX, rewrite it down to the most recent TRIM bytes.
const MAX_LOG_BYTES = 4 * 1024 * 1024
const TRIM_LOG_BYTES = 1 * 1024 * 1024

// CSI (colors/cursor), OSC (titles/hyperlinks), and stray escapes — logs must
// be plain text so agents can grep them without terminal-control noise.
const CSI_RE =
  // eslint-disable-next-line no-control-regex
  /\u001b\[[0-?]*[ -/]*[@-~]/g
const OSC_RE =
  // eslint-disable-next-line no-control-regex
  /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g
// Remaining two-byte Fe escapes; any stray lone ESC falls into the final
// control-char sweep below.
const OTHER_ESC_RE =
  // eslint-disable-next-line no-control-regex
  /\u001b[@-Z\\-_]/g
// Everything below 0x20 except \n and \t, plus DEL.
const RESIDUAL_CONTROL_RE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g

export function stripTerminalSequences(data: string): string {
  return (
    data
      .replace(OSC_RE, '')
      .replace(CSI_RE, '')
      .replace(OTHER_ESC_RE, '')
      // Progress spinners rewrite lines with bare \r; in a file each rewrite
      // becomes its own line so the final state is still readable.
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(RESIDUAL_CONTROL_RE, '')
  )
}

type LogCapture = {
  repoId: string
  ptyId: string
  logPath: string
  unsubscribe: () => void
  pending: string
  writeChain: Promise<void>
  approxBytes: number
  /** Watches .orca/ for the agent-written restart trigger file. */
  triggerWatcher: FSWatcher | null
  restartInFlight: boolean
}

const capturesByRepoId = new Map<string, LogCapture>()
let providerRebindInstalled = false

function subscribeCapture(capture: LogCapture): void {
  capture.unsubscribe = getLocalPtyProvider().onData((payload: { id: string; data: string }) => {
    if (payload.id !== capture.ptyId) {
      return
    }
    capture.pending += payload.data
    scheduleFlush(capture)
  })
}

function scheduleFlush(capture: LogCapture): void {
  capture.writeChain = capture.writeChain.then(async () => {
    if (!capture.pending) {
      return
    }
    const chunk = stripTerminalSequences(capture.pending)
    capture.pending = ''
    if (!chunk) {
      return
    }
    try {
      await appendFile(capture.logPath, chunk, 'utf-8')
      capture.approxBytes += Buffer.byteLength(chunk)
      if (capture.approxBytes > MAX_LOG_BYTES) {
        const content = await readFile(capture.logPath, 'utf-8')
        const trimmed = content.slice(-TRIM_LOG_BYTES)
        const firstNewline = trimmed.indexOf('\n')
        await writeFile(
          capture.logPath,
          `[log trimmed by Orca]\n${firstNewline === -1 ? trimmed : trimmed.slice(firstNewline + 1)}`,
          'utf-8'
        )
        capture.approxBytes = TRIM_LOG_BYTES
      }
    } catch {
      // Non-fatal: the log dir may have been removed mid-session; the next
      // capture start recreates it.
    }
  })
}

/** Make sure `.orca/` is ignored in the root checkout without touching the
 *  repo's tracked .gitignore — `.git/info/exclude` is local-only by design. */
async function ensureOrcaDirExcluded(rootPath: string): Promise<void> {
  const { stdout } = await gitExecFileAsync(['rev-parse', '--git-path', 'info/exclude'], {
    cwd: rootPath
  })
  const excludePath = path.resolve(rootPath, stdout.trim())
  let current = ''
  try {
    current = await readFile(excludePath, 'utf-8')
  } catch {
    // Missing file is fine — created below.
  }
  if (current.split(/\r?\n/).some((line) => line.trim() === '.orca/')) {
    return
  }
  await mkdir(path.dirname(excludePath), { recursive: true })
  const separator = current.length > 0 && !current.endsWith('\n') ? '\n' : ''
  await writeFile(excludePath, `${current}${separator}# Orca Spotlight logs\n.orca/\n`, 'utf-8')
}

export async function startSpotlightLogCapture(args: {
  repoId: string
  ptyId: string
  rootPath: string
}): Promise<void> {
  const existing = capturesByRepoId.get(args.repoId)
  if (existing?.ptyId === args.ptyId) {
    return
  }
  existing?.unsubscribe()

  const logPath = path.join(args.rootPath, ...SPOTLIGHT_LOG_RELATIVE_PATH.split('/'))
  await mkdir(path.dirname(logPath), { recursive: true })
  await ensureOrcaDirExcluded(args.rootPath).catch(() => {
    // Best-effort: without the exclude the log shows up as untracked in the
    // root, which is cosmetic — never block capture on it.
  })
  await appendFile(
    logPath,
    `\n──── Orca Spotlight terminal capture started ${new Date().toISOString()} ────\n`,
    'utf-8'
  ).catch(() => {})

  const capture: LogCapture = {
    repoId: args.repoId,
    ptyId: args.ptyId,
    logPath,
    unsubscribe: () => {},
    pending: '',
    writeChain: Promise.resolve(),
    approxBytes: 0,
    triggerWatcher: null,
    restartInFlight: false
  }
  subscribeCapture(capture)
  watchRestartTrigger(capture)
  capturesByRepoId.set(args.repoId, capture)

  if (!providerRebindInstalled) {
    providerRebindInstalled = true
    // A daemon swap replaces the provider instance; re-subscribe every live
    // capture on the new one so daemon restarts don't silently end mirroring.
    onLocalPtyProviderChanged(() => {
      for (const live of capturesByRepoId.values()) {
        live.unsubscribe()
        subscribeCapture(live)
      }
    })
  }
}

export const SPOTLIGHT_RESTART_TRIGGER_FILENAME = 'spotlight-restart'
// Delay between the interrupt and re-running the command: long enough for the
// server to release the prompt, short enough to feel immediate.
const RESTART_RERUN_DELAY_MS = 700

/** Agent-safe server restart: interrupt the Spotlight terminal's foreground
 *  process and re-run the last command via the shell's in-memory history
 *  (up-arrow + enter — works in bash/zsh/fish regardless of HISTFILE config). */
export function restartSpotlightServer(repoId: string): boolean {
  const capture = capturesByRepoId.get(repoId)
  if (!capture || capture.restartInFlight) {
    return false
  }
  capture.restartInFlight = true
  void appendSpotlightLogNote(
    path.dirname(path.dirname(capture.logPath)),
    'Restarting the server (requested from a workspace)'
  )
  try {
    getLocalPtyProvider().write(capture.ptyId, '\x03')
  } catch {
    capture.restartInFlight = false
    return false
  }
  setTimeout(() => {
    try {
      getLocalPtyProvider().write(capture.ptyId, '\x1b[A\r')
    } catch {
      // PTY died between interrupt and re-run; nothing else to do.
    } finally {
      capture.restartInFlight = false
    }
  }, RESTART_RERUN_DELAY_MS)
  return true
}

/** Watch .orca/ for the agent trigger: `touch .orca/spotlight-restart` in the
 *  repo root asks Orca to restart the server. File-based so it works for any
 *  agent in any worktree with zero CLI installation (the path is derivable
 *  from $ORCA_SPOTLIGHT_LOG). */
function watchRestartTrigger(capture: LogCapture): void {
  const orcaDir = path.dirname(capture.logPath)
  const triggerPath = path.join(orcaDir, SPOTLIGHT_RESTART_TRIGGER_FILENAME)
  const consumeTrigger = (): void => {
    void stat(triggerPath)
      .then(async () => {
        // Delete BEFORE acting so a slow restart can't loop on its own trigger.
        await rm(triggerPath, { force: true })
        restartSpotlightServer(capture.repoId)
      })
      .catch(() => {
        // Trigger absent — the event was for another file in .orca/.
      })
  }
  try {
    capture.triggerWatcher = watch(orcaDir, (_event, filename) => {
      if (filename === SPOTLIGHT_RESTART_TRIGGER_FILENAME) {
        consumeTrigger()
      }
    })
    // A trigger written while no capture was live should still be honored.
    consumeTrigger()
  } catch {
    capture.triggerWatcher = null
  }
}

/** Write a marker line into the log (holder switches, spotlight off) so agents
 *  reading it know WHOSE workspace the surrounding output belongs to. */
export async function appendSpotlightLogNote(rootPath: string, note: string): Promise<void> {
  try {
    const logPath = path.join(rootPath, ...SPOTLIGHT_LOG_RELATIVE_PATH.split('/'))
    await mkdir(path.dirname(logPath), { recursive: true })
    await appendFile(logPath, `\n──── ${note} (${new Date().toISOString()}) ────\n`, 'utf-8')
  } catch {
    // Best-effort marker; never block a spotlight operation on it.
  }
}

export function stopSpotlightLogCapture(args: { repoId: string; ptyId?: string }): void {
  const capture = capturesByRepoId.get(args.repoId)
  if (!capture || (args.ptyId !== undefined && capture.ptyId !== args.ptyId)) {
    return
  }
  capture.unsubscribe()
  capture.triggerWatcher?.close()
  capturesByRepoId.delete(args.repoId)
}
