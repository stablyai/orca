import { app } from 'electron'
import { BrowserBookmarkStore } from './browser-bookmark-store'

let store: BrowserBookmarkStore | undefined

export function configureBrowserBookmarkStore(profileDirectory: string): void {
  store = new BrowserBookmarkStore(profileDirectory)
}

export function getBrowserBookmarkStore(): BrowserBookmarkStore {
  return (store ??= new BrowserBookmarkStore(app.getPath('userData')))
}
