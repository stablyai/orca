/** `orca://` links main captured from launch argv or open-url, pushed live or pulled on renderer mount. */
export type DeepLinkEventApi = {
  onOpenSkillShare: (callback: (shareId: string) => void) => () => void
  consumePendingSkillShare: () => Promise<string | null>
  /** Raw `orca://plugins/...` link; the renderer validates it. */
  onOpenPluginInstallLink: (callback: (link: string) => void) => () => void
  consumePendingPluginInstallLink: () => Promise<string | null>
  /** Raw `orca://pair?...` link; the add-server dialog validates it and the user confirms. */
  onOpenRemotePairingLink: (callback: (link: string) => void) => () => void
  consumePendingRemotePairingLink: () => Promise<string | null>
}
