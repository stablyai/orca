// A document keeps the credential it mounted under until its remount; check the live entry at
// each receipt so a gone entry or a replacement credential stops the old document's writes too.
export function createDocumentNativeAuthority(
  hostId: string,
  documentClientId: string | null,
  getClientId: (hostId: string) => string | null
) {
  const isCurrent = () => documentClientId !== null && getClientId(hostId) === documentClientId
  return {
    isCurrent,
    // One-way storage notifications owe no reply, so a write without authority is dropped.
    fenceStorageWrite:
      (write: (key: string, value: string | null) => void) =>
      (key: string, value: string | null): void => {
        if (isCurrent()) {
          write(key, value)
        }
      }
  }
}
