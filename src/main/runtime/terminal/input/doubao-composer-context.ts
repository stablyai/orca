import { win32 } from 'node:path'
import type { RuntimePtyWorktreeRecord } from '../records/runtime-terminal-state-records'
import { getAppEnvironment } from '../../../../shared/app-lifecycle/app-environment'
import { getWindowsWorkerCliLauncher } from '../../../cli/launchers/orca-cli-child-path'
import {
  detectTerminalComposerDraft,
  readTerminalComposerTypedText,
  type TerminalCursorContext
} from '../../../../shared/terminal/input/terminal-composer-draft'
import { wrapTerminalBracketedPasteText } from '../../../../shared/terminal/input/terminal-bracketed-paste-text'

/** The live edit box and its workspace footer must both surround the terminal's actual caret. */
export function doubaoSubmitDraft(cursor: TerminalCursorContext | null): string | null {
  const draft = detectTerminalComposerDraft(cursor)
  if (!cursor || draft?.promptGlyph !== '❯') {
    return null
  }
  const frame = draft.endRow - draft.cursorRow
  if (
    !/^\s*─{8,}\s*$/.test(cursor.rowsBelow[frame] ?? '') ||
    !/ · [^·]{1,48} · (?:[a-z]:[\\/]|\\\\)/i.test(cursor.rowsBelow[frame + 1] ?? '')
  ) {
    return null
  }
  return readTerminalComposerTypedText(cursor)?.trim() || null
}

export function doubaoSessionSubmit(
  cli: string | null,
  userDataPath: string,
  handle: string
): string | null {
  if (!cli || !win32.isAbsolute(cli) || !win32.isAbsolute(userDataPath)) {
    return null
  }
  const context = {
    cli,
    ORCA_USER_DATA_PATH: userDataPath,
    ORCA_TERMINAL_HANDLE: handle
  }
  // Keep the annotation one inert line even if a shell replaces the composer during the write.
  const json = JSON.stringify(context).replace(
    /[&|<>^%!`$;\u007f-\u009f\u2028\u2029]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`
  )
  const paste = wrapTerminalBracketedPasteText(
    ` # Orca session context for local Orca calls: invoke the exact cli and set both environment variables in each tool shell. ${json}`
  )
  // Doubao's Ctrl+E moves to the end of the entire draft, including scrolled-off lines.
  return `\x05${paste}\r`
}

export class DoubaoComposerContexts {
  private readonly attempts = new WeakMap<RuntimePtyWorktreeRecord, { binding: string }>()

  reset(pty: RuntimePtyWorktreeRecord): void {
    this.attempts.delete(pty)
  }

  prepare(
    pty: RuntimePtyWorktreeRecord,
    launchToken: string,
    handle: string
  ): { data: string; rejected: () => void } | null {
    const binding = `${launchToken}:${handle}`
    if (this.attempts.get(pty)?.binding === binding) {
      return null
    }
    const cli = getWindowsWorkerCliLauncher()
    const data = cli && doubaoSessionSubmit(cli, getAppEnvironment().getPath('userData'), handle)
    if (!data) {
      return null
    }
    const attempt = { binding }
    this.attempts.set(pty, attempt)
    return {
      data,
      rejected: () => {
        if (this.attempts.get(pty) === attempt) {
          this.attempts.delete(pty)
        }
      }
    }
  }
}
