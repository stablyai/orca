import type { TerminalSnapshot } from '../../protocol/terminal-snapshot'

/** Copies every code unit, lone surrogates included, into backing shared with no other string. */
function detach(value: string): string {
  return Buffer.from(value, 'utf16le').toString('utf16le')
}

/**
 * A retained result must not keep a pending record alive through a small slice of it. Title,
 * cwd, link targets and the parser tail come from replay input; the serialized cell output is
 * built fresh by the serializer.
 */
export function detachTerminalSnapshotStrings(snapshot: TerminalSnapshot): TerminalSnapshot {
  return {
    ...snapshot,
    cwd: snapshot.cwd === null ? null : detach(snapshot.cwd),
    ...(snapshot.lastTitle !== undefined ? { lastTitle: detach(snapshot.lastTitle) } : {}),
    ...(snapshot.pendingEscapeTailAnsi !== undefined
      ? { pendingEscapeTailAnsi: detach(snapshot.pendingEscapeTailAnsi) }
      : {}),
    ...(snapshot.oscLinks
      ? { oscLinks: snapshot.oscLinks.map((link) => ({ ...link, uri: detach(link.uri) })) }
      : {})
  }
}
