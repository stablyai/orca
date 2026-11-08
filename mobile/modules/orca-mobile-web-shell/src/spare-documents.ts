import { requireNativeModule } from 'expo-modules-core'

type SpareDocumentModule = {
  prepareSpareDocument: (
    buildId: string,
    hostKey: string,
    directory: string,
    sessionId: string,
    replace: boolean
  ) => Promise<boolean>
  claimSpareDocument: (
    buildId: string,
    hostKey: string,
    directory: string
  ) => Promise<string | null>
  discardSpareDocuments: (hostKey: string | null) => Promise<void>
}

const spareDocuments = (): SpareDocumentModule =>
  requireNativeModule<SpareDocumentModule>('OrcaMobileWebShell')

// Boot a page under `sessionId` from `directory` and park it, invisible, until a screen claims it.
// False when native declined: a phone under 3 GB, a spare of this build already parked, another one
// parked and `replace` false, two documents already live, or the app not active. One app-wide.
export function prepareSpareDocument(
  buildId: string,
  hostKey: string,
  directory: string,
  sessionId: string,
  replace: boolean
): Promise<boolean> {
  return spareDocuments().prepareSpareDocument(buildId, hostKey, directory, sessionId, replace)
}

// The parked spare's session id, handed out once, when `directory` holds the same build. The view
// mounted with that id adopts the booted page, which then serves `hostKey`'s `directory`.
export function claimSpareDocument(
  buildId: string,
  hostKey: string,
  directory: string
): Promise<string | null> {
  return spareDocuments().claimSpareDocument(buildId, hostKey, directory)
}

// Drop spares booted from `hostKey`'s files before they go, or every spare for null.
export function discardSpareDocuments(hostKey: string | null): Promise<void> {
  return spareDocuments().discardSpareDocuments(hostKey)
}
