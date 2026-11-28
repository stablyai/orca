/** The detector's only way out of the guest: main's IPC, adapted so tests can stand in for it. */
export type BrowserPasswordGuestPort = {
  send: (channel: string, payload: unknown) => void
  on: (channel: string, listener: (payload: unknown) => void) => void
}
