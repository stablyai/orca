// Mirrors the Spotlight terminal's PTY output into <repoRoot>/.orca/spotlight.log
// so agents running in any worktree can read the dev server's logs (the server
// runs once, at the repo root, inside the Spotlight terminal tab).
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
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
    approxBytes: 0
  }
  subscribeCapture(capture)
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
  capturesByRepoId.delete(args.repoId)
}
