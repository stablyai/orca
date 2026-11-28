// Why: the page edits in a textarea, which turns every CR and CRLF into LF, so a save puts the file's ending back.
export function editorTextOfFileText(fileText: string): string {
  return fileText.replace(/\r\n?/g, '\n')
}

/** `draft` written with `fileText`'s dominant line ending (CRLF, lone CR or LF), as the desktop editor keeps one per file. */
export function fileTextOfEditorText(draft: string, fileText: string): string {
  const crlf = fileText.split('\r\n').length - 1
  const cr = fileText.split('\r').length - 1 - crlf
  const lf = fileText.split('\n').length - 1 - crlf
  if (crlf > lf && crlf >= cr) {
    return draft.replace(/\n/g, '\r\n')
  }
  return cr > lf && cr > crlf ? draft.replace(/\n/g, '\r') : draft
}
