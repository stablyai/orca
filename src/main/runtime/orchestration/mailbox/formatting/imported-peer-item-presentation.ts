/** Mail a paired Orca sent here, by the queue item kind it arrived as. */
export type ImportedPeerItem =
  /** A reply in a peer-mail conversation this Orca opened. */
  | { kind: 'peer_mail'; senderLabel: string; body: string }
  /** A message filed in the mailbox of a Run this Orca coordinates on that server. */
  | { kind: 'worker_mail'; from: string; body: string }

/** The one place that decides how an imported peer item is stored: its sender label and body. */
export function presentImportedPeerItem(item: ImportedPeerItem): { from: string; body: string } {
  return item.kind === 'peer_mail'
    ? { from: item.senderLabel, body: item.body }
    : { from: item.from, body: item.body }
}
