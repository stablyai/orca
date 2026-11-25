// Native sockets have no bridge-frame cap; omit a client limit so the host keeps its full scrollback budget. The web sibling subtracts serialized bridge overhead.
export function mobileTerminalSnapshotByteBudget(): number | undefined {
  return undefined
}
