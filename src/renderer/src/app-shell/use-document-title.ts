import { useEffect } from 'react'
import { useActiveWorktree, useRepoById } from '../store/selectors'

const DEFAULT_DOCUMENT_TITLE = 'Orca'

/** Mirrors the active project's name into the native window title. */
export function useDocumentTitle(): void {
  const activeWorktree = useActiveWorktree()
  const projectName = useRepoById(activeWorktree?.repoId ?? null)?.displayName

  // Why: Electron copies document.title to the OS window title, the only per-project signal time trackers can read.
  useEffect(() => {
    const trimmedProjectName = projectName?.trim()
    document.title = trimmedProjectName
      ? `${DEFAULT_DOCUMENT_TITLE} - ${trimmedProjectName}`
      : DEFAULT_DOCUMENT_TITLE
  }, [projectName])
}
