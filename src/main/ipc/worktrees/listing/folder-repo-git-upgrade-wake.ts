let wakeListener: (() => void) | null = null

export function setFolderRepoGitUpgradeWakeListener(listener: (() => void) | null): void {
  wakeListener = listener
}

export function wakeFolderRepoGitUpgradeWatch(): void {
  wakeListener?.()
}
