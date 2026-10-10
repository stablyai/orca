import { runProcess } from '../../shared/child-process/run-process'
import { writeClipboardTextAndVerify } from './clipboard-text-write-verify'

const WAYLAND_CLIPBOARD_READ_TIMEOUT_MS = 500

type TerminalClipboardHost = {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
}

let pendingTerminalClipboardWrite: Promise<void> = Promise.resolve()

// Why: validation and the Wayland pre-read both yield, so rapid copies could land out of order.
export function enqueueTerminalClipboardWrite(write: () => Promise<void>): Promise<void> {
  const next = pendingTerminalClipboardWrite.then(write)
  pendingTerminalClipboardWrite = next.catch(() => undefined)
  return next
}

// Why skip identical text on Wayland (#23229): after an agent's wl-copy, wlroots ignores our
// older-serial set_selection without `cancelled`, and Chromium then serves its stale copy forever.
export async function writeTerminalClipboardText(
  text: string,
  host: TerminalClipboardHost = { platform: process.platform, env: process.env }
): Promise<void> {
  if (await isTextAlreadyOnWaylandClipboard(text, host)) {
    return
  }
  writeClipboardTextAndVerify(text)
}

async function isTextAlreadyOnWaylandClipboard(
  text: string,
  host: TerminalClipboardHost
): Promise<boolean> {
  if (host.platform !== 'linux' || !host.env.WAYLAND_DISPLAY) {
    return false
  }
  try {
    // Why async: when Orca owns the selection, wl-paste waits for Orca's main process to serve it.
    const result = await runProcess({
      program: 'wl-paste',
      args: ['--no-newline'],
      timeoutMs: WAYLAND_CLIPBOARD_READ_TIMEOUT_MS,
      maxOutputBytes: Buffer.byteLength(text) + 1
    })
    return (
      result.code === 0 && !result.timedOut && !result.outputTruncated && result.stdout === text
    )
  } catch {
    // wl-paste is optional; without it keep the existing write path.
    return false
  }
}
