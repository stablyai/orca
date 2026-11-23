/** One paired server's This-device pages, as Memory Saver's discard IPC and notice see them. */
export type BrowserClientPageMemoryOwner = {
  ownsGuest(browserPageId: string, guestId: number): boolean
  canFree(browserPageId: string, guest: Electron.WebContents): boolean
  free(browserPageId: string, guest: Electron.WebContents): boolean
  wake(browserPageId: string): Promise<boolean> | null
}

const owners = new Set<BrowserClientPageMemoryOwner>()

export function registerBrowserClientPageMemoryOwner(
  owner: BrowserClientPageMemoryOwner
): () => void {
  owners.add(owner)
  return () => owners.delete(owner)
}

/** A This-device guest: its paired-server executor, not page memory, frees and remakes it. */
export function isBrowserClientPageGuest(browserPageId: string, guestId: number): boolean {
  return [...owners].some((owner) => owner.ownsGuest(browserPageId, guestId))
}

export function canFreeBrowserClientPageGuest(
  browserPageId: string,
  guest: Electron.WebContents
): boolean {
  return [...owners].some((owner) => owner.canFree(browserPageId, guest))
}

/** Synchronous commit: on true the page is freed and its guest is being retired. */
export function freeBrowserClientPageGuest(
  browserPageId: string,
  guest: Electron.WebContents
): boolean {
  return [...owners].some((owner) => owner.free(browserPageId, guest))
}

/** Remakes a freed This-device page; false when no executor had it freed or the remake failed. */
export async function wakeBrowserClientPage(browserPageId: string): Promise<boolean> {
  for (const owner of owners) {
    const woken = owner.wake(browserPageId)
    if (woken) {
      return woken
    }
  }
  return false
}
