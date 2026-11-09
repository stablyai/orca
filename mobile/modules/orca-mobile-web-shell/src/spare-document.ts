import { requireOptionalNativeModule } from 'expo-modules-core'

type SpareDocumentModule = {
  prepareSpareDocument?: (directory: string, sessionId: string) => Promise<boolean>
  claimSpareDocument?: (directory: string) => Promise<string | null>
  discardSpareDocument?: () => Promise<void>
}

// A binary built before the spare existed has the module without these functions.
const spareModule = (): SpareDocumentModule | null =>
  requireOptionalNativeModule<SpareDocumentModule>('OrcaMobileWebShell')

// Boot a page from `directory` under `sessionId` and park it, invisible, until a screen claims it.
// False when native declined: a phone under 4 GB, the app not active, or a page document shown.
export async function prepareSpareDocument(directory: string, sessionId: string): Promise<boolean> {
  return (await spareModule()?.prepareSpareDocument?.(directory, sessionId)) ?? false
}

// The parked spare's session id when it was booted from `directory`, handed out once. The view
// mounted under that id adopts the booted page.
export async function claimSpareDocument(directory: string): Promise<string | null> {
  return (await spareModule()?.claimSpareDocument?.(directory)) ?? null
}

export async function discardSpareDocument(): Promise<void> {
  await spareModule()?.discardSpareDocument?.()
}
