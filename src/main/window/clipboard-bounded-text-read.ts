import { clipboard } from 'electron'
import { runProcess } from '@orca/process-host'
import {
  CLIPBOARD_TEXT_READ_MAX_BYTES,
  CLIPBOARD_TEXT_READ_UNRESPONSIVE_ERROR
} from '../../shared/clipboard-text'

/**
 * A macOS pasteboard item can be a promise whose owner never delivers: AppKit then
 * blocks the requesting thread until its own keeper timeout expires (~120 s), so one
 * stuck clipboard item froze the whole app on terminal paste (#23913). pbpaste asks
 * for the same NSPasteboardTypeString payload in a disposable process the read can
 * abandon, and a non-zero helper wait resolves as an unresponsive clipboard error.
 * Other platforms have no pasteboard promise mechanism, so they keep the direct read.
 */
export const CLIPBOARD_TEXT_READ_BOUND_MS = 2_000

const PBPASTE_PROGRAM = '/usr/bin/pbpaste'

export type BoundedClipboardTextReadDeps = {
  runProcess: typeof runProcess
  readClipboardTextDirect: () => string
  platform: NodeJS.Platform
}

export function readClipboardTextWithBoundedWait(
  deps: BoundedClipboardTextReadDeps = {
    runProcess,
    readClipboardTextDirect: () => clipboard.readText(),
    platform: process.platform
  }
): Promise<string> {
  if (deps.platform !== 'darwin') {
    return Promise.resolve(deps.readClipboardTextDirect())
  }
  return deps
    .runProcess({
      program: PBPASTE_PROGRAM,
      timeoutMs: CLIPBOARD_TEXT_READ_BOUND_MS,
      // Capture one byte past the shared read limit so an over-limit item reaches the
      // caller's limit assertion as too-large instead of being silently truncated.
      maxOutputBytes: CLIPBOARD_TEXT_READ_MAX_BYTES + 1,
      killOnOutputLimit: true
    })
    .then(
      (result) => {
        if (result.timedOut) {
          throw new Error(CLIPBOARD_TEXT_READ_UNRESPONSIVE_ERROR)
        }
        return result.stdout
      },
      // A helper that cannot spawn is an environment problem, not a stuck owner: the
      // direct read keeps today's behavior instead of disabling paste entirely.
      () => deps.readClipboardTextDirect()
    )
}
