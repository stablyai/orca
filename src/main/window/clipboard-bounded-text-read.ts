import { clipboard } from 'electron'
import { runProcess } from '@orca/process-host'
import {
  CLIPBOARD_TEXT_READ_FAILED_ERROR,
  CLIPBOARD_TEXT_READ_MAX_BYTES,
  CLIPBOARD_TEXT_READ_UNRESPONSIVE_ERROR,
  CLIPBOARD_TEXT_TOO_LARGE_ERROR
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
      killOnOutputLimit: true,
      // A GUI launch can leave the environment without a locale while the helper's
      // stdout is decoded as UTF-8; pin pbpaste to UTF-8 so the pasteboard text
      // arrives as those bytes instead of a legacy-encoding transcode.
      env: { ...process.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' }
    })
    .then(
      (result) => {
        if (result.timedOut) {
          throw new Error(CLIPBOARD_TEXT_READ_UNRESPONSIVE_ERROR)
        }
        if (result.outputTruncated) {
          // killOnOutputLimit stopped the helper at the capture cap, so the item is
          // larger than what was captured; fail loudly instead of pasting partial text.
          throw new Error(CLIPBOARD_TEXT_TOO_LARGE_ERROR)
        }
        if (result.code !== 0) {
          // A helper that exits nonzero delivered no trustworthy payload; an empty
          // resolve would read as a successful paste of nothing.
          throw new Error(CLIPBOARD_TEXT_READ_FAILED_ERROR)
        }
        return result.stdout
      },
      // A helper that cannot spawn is an environment problem, not a stuck owner: the
      // direct read keeps today's behavior instead of disabling paste entirely.
      () => deps.readClipboardTextDirect()
    )
}
