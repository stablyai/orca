import { useMemo } from 'react'
import { parseExecutionHostId } from '../../../src/shared/execution-host'
import { NativeVerbError, useNativeVerbs } from '../mobile-web-shell/bridge/use-native-verbs'
import { useWorkspaceExecutionHost } from '../navigation/workspace-execution-host'
import { PdfOpenRefusedError, type PdfOpener } from './pdf-opener-contract'

// Older shells lack the verbs, so callers get null and ask for an app update instead.
export function usePdfOpener(): PdfOpener | null {
  const verbs = useNativeVerbs()
  const server = parseExecutionHostId(useWorkspaceExecutionHost())
  const executionHost = server?.kind === 'runtime' ? server.id : undefined
  return useMemo(() => {
    if (!verbs.canOpenPdf) {
      return null
    }
    return {
      open: async ({ worktreeId, relativePath }) => {
        try {
          await verbs.openPdf({
            worktreeId,
            relativePath,
            ...(executionHost ? { executionHost } : {})
          })
        } catch (error) {
          if (error instanceof NativeVerbError && error.reason === 'native_pdf_no_viewer') {
            throw new PdfOpenRefusedError('No app on this phone can open PDFs')
          }
          if (error instanceof NativeVerbError && error.reason === 'native_pdf_host_outdated') {
            throw new PdfOpenRefusedError(
              'Update Orca where this workspace runs to open PDFs on mobile'
            )
          }
          throw new Error('Unable to open this PDF')
        }
      },
      cancel: () => {
        void verbs.cancelPdf().catch(() => {})
      }
    }
  }, [verbs, executionHost])
}
