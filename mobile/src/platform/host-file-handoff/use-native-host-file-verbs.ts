import { useNativeFileSharer } from '../file-sharing/native-file-share'
import { useNativePdfViewer } from '../pdf-viewing/native-pdf-view'

/** The verbs that download a workspace file for a system viewer or sheet: PDFs to view, any file to share. */
export function useNativeHostFileVerbs(hostId: string, sessionId: string | null) {
  const servePdfView = useNativePdfViewer(hostId, sessionId)
  const serveFileShare = useNativeFileSharer(hostId, sessionId)
  return (verb: 'native.pdf.view' | 'native.file.share', params: unknown): Promise<unknown> =>
    verb === 'native.pdf.view' ? servePdfView(params) : serveFileShare(params)
}
