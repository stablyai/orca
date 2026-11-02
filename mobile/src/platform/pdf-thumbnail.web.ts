import { useMemo } from 'react'
import { parseExecutionHostId } from '../../../src/shared/execution-host'
import { useNativeVerbs } from '../mobile-web-shell/bridge/use-native-verbs'
import { useWorkspaceExecutionHost } from '../navigation/workspace-execution-host'
import type { PdfThumbnailer } from './pdf-thumbnail'

// One render per file for the page's lifetime; scrolling a chat back and forth must not redownload PDFs.
// A failure is forgotten, so the next tile to mount retries (say, once the desktop is reachable again).
const pages = new Map<string, Promise<string | null>>()

// Older shells lack the verb, so tiles keep their document icon.
export function usePdfThumbnailer(): PdfThumbnailer | null {
  const verbs = useNativeVerbs()
  const server = parseExecutionHostId(useWorkspaceExecutionHost())
  const executionHost = server?.kind === 'runtime' ? server.id : undefined
  return useMemo(() => {
    if (!verbs.canThumbnailPdf) {
      return null
    }
    return (worktreeId, relativePath) => {
      const key = `${executionHost ?? ''}\0${worktreeId}\0${relativePath}`
      let page = pages.get(key)
      if (!page) {
        page = verbs
          .thumbnailPdf({ worktreeId, relativePath, ...(executionHost ? { executionHost } : {}) })
          .then((jpegBase64) => `data:image/jpeg;base64,${jpegBase64}`)
          .catch(() => {
            pages.delete(key)
            return null
          })
        pages.set(key, page)
      }
      return page
    }
  }, [verbs, executionHost])
}
