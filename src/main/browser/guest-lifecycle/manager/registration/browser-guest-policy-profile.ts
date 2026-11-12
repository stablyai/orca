/** Document guests render one grant and report only to its host; browsing policies do not apply. */
export type BrowserGuestPolicy =
  | { profile: 'browsing' }
  | { profile: 'workspace-doc'; host: Electron.WebContents }

export const BROWSING_GUEST_POLICY: BrowserGuestPolicy = { profile: 'browsing' }
