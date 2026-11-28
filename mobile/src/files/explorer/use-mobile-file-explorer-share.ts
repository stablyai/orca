import { useEffect, useRef, useState } from 'react'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { FileShareRefusedError } from '../../platform/file-sharing/file-sharer-contract'
import { useFileSharer } from '../../platform/file-sharing/file-sharer'
import { triggerError } from '../../platform/haptics/haptics'
import type { TreeNode } from './file-tree'

/** Share for a file row: the shell downloads it, then opens the system share sheet. Null on shells without it. */
export function useMobileFileExplorerShare(
  /** The workspace shown; a share started in another is abandoned. */
  scope: string,
  worktreeId: string,
  showToast: (message: string) => void
) {
  const t = useMobileTranslation()
  const sharer = useFileSharer()
  // The row whose file is downloading; its sheet row spins until the share sheet is up.
  const [sharing, setSharing] = useState<string | null>(null)
  const pending = useRef<object | null>(null)

  const share = (node: TreeNode, onShown: () => void) => {
    if (!sharer || pending.current) {
      return
    }
    const attempt = {}
    pending.current = attempt
    setSharing(node.relativePath)
    void sharer.share({ worktreeId, relativePath: node.relativePath }).then(
      () => {
        if (pending.current === attempt) {
          pending.current = null
          setSharing(null)
          onShown()
        }
      },
      (error: unknown) => {
        // A cancelled share ends quietly: the user backed out of it.
        if (pending.current !== attempt) {
          return
        }
        pending.current = null
        setSharing(null)
        triggerError()
        showToast(
          error instanceof FileShareRefusedError
            ? error.message
            : t('files.fileExplorerRowActions.shareFailed', "Couldn't share {{name}}", {
                name: node.name
              })
        )
      }
    )
  }

  // Leaving Files (another dock tab, a closed bot sheet) or showing another workspace abandons a
  // download as closing the sheet does.
  const sharerRef = useRef(sharer)
  useEffect(() => {
    sharerRef.current = sharer
  })
  useEffect(
    () => () => {
      if (pending.current) {
        pending.current = null
        setSharing(null)
        sharerRef.current?.cancel()
      }
    },
    [scope]
  )

  // Closing the sheet while the file downloads abandons it, so no share sheet opens later.
  const cancel = () => {
    if (pending.current) {
      pending.current = null
      setSharing(null)
      sharer?.cancel()
    }
  }

  return sharer ? { sharing, share, cancel } : null
}
