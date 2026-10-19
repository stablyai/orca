// Peer-supplied close reasons are logged; keep them printable and short.
export function printableCloseReason(reason: Buffer | string): string {
  return reason
    .toString()
    .replace(/[^\x20-\x7e]/g, '')
    .slice(0, 80)
}
