/** window.api.browser members for a tab's sound: the speaker icon and Mute Tab. */
export type BrowserTabAudioApi = {
  setPageAudioMuted: (args: { browserPageId: string; muted: boolean }) => Promise<boolean>
  onAudioStateChanged: (
    callback: (event: { browserPageId: string; audible: boolean }) => void
  ) => () => void
  /** A paired viewer muted or unmuted one of this window's pages. */
  onAudioMutedChanged: (
    callback: (event: { browserPageId: string; muted: boolean }) => void
  ) => () => void
}
