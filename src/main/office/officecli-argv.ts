/**
 * Argument vectors for every `officecli` call Orca makes. Pure, so the shapes are testable
 * without a binary and without a host.
 *
 * Two rules hold across all of them:
 *
 *  - Document paths are always the canonical absolute path. `officecli unwatch` keys its
 *    registry on the literal spelling `watch` was given, so a watch started with a relative
 *    path can never be stopped by an absolute one (verified against 1.0.148: `unwatch` answers
 *    "No watch running" and leaves the server listening). Canonicalising at the edge is what
 *    makes teardown work at all, not just what keeps two opens of one file from racing.
 *  - Nothing is ever interpolated into a shell string. These are argv arrays; the runner quotes.
 */

export type OfficecliArgv = readonly string[]

export function officecliVersionArgs(): OfficecliArgv {
  return ['--version']
}

/** `view <file> html -o <out>` writes one self-contained HTML file and prints its path. */
export function officecliRenderArgs(documentPath: string, outputPath: string): OfficecliArgv {
  return ['view', documentPath, 'html', '-o', outputPath, '--json']
}

export function officecliWatchStartArgs(documentPath: string, port: number): OfficecliArgv {
  return ['watch', documentPath, '--port', String(port)]
}

export function officecliWatchStopArgs(documentPath: string): OfficecliArgv {
  return ['unwatch', documentPath]
}

export function officecliSelectionArgs(documentPath: string): OfficecliArgv {
  return ['get', documentPath, 'selected', '--json']
}

export function officecliMarksArgs(documentPath: string): OfficecliArgv {
  return ['watch', 'marks', documentPath, '--json']
}

export function officecliUnmarkAllArgs(documentPath: string): OfficecliArgv {
  return ['watch', 'unmark', documentPath, '--all']
}

/** Scrolls every connected live page to one element. The read side of marks needs it to be useful. */
export function officecliGotoArgs(documentPath: string, elementPath: string): OfficecliArgv {
  return ['watch', 'goto', documentPath, elementPath]
}

export function officecliSkillsListArgs(): OfficecliArgv {
  return ['skills', 'list']
}

export function officecliSkillsInstallArgs(skill: string, agent: string): OfficecliArgv {
  return ['skills', 'install', skill, agent]
}

/**
 * Force a re-render on a running watch server.
 *
 * Not a CLI call: `officecli watch` does not detect external edits, and an agent editing the
 * document is exactly that case. The documented remedy is re-POSTing the same path to the
 * server's own switch endpoint, which re-renders and tells connected pages to reload.
 *
 * The field is `file`, verified against 1.0.148 — `path` answers `400 missing required field:
 * file`. Reloading the webview instead would not work: `GET /` serves the server's cached
 * render, so the reader would see the stale document and think the button did nothing.
 */
export function officecliSwitchRequest(
  port: number,
  documentPath: string
): { url: string; body: string } {
  return {
    url: `http://127.0.0.1:${port}/api/switch`,
    body: JSON.stringify({ file: documentPath })
  }
}

export function officecliWatchOrigin(port: number): string {
  return `http://127.0.0.1:${port}`
}
