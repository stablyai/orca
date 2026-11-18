// Reads a PDF's text off the host's main thread: a long PDF would otherwise freeze the window.
import { parentPort } from 'node:worker_threads'
import { pdfText } from './google-pdf-text'
import type { PdfTextWorkerRequest, PdfTextWorkerResponse } from './google-pdf-text-worker-protocol'
import { installWorkerSendLedger } from '../worker-threads/worker-send-ledger'

installWorkerSendLedger('orca-google-pdf-text')

if (!parentPort) {
  throw new Error('PDF text worker requires a parent port.')
}
const port = parentPort

port.on('message', (request: PdfTextWorkerRequest) => {
  void pdfText(request.data).then(
    ({ text, pages }) => {
      const response: PdfTextWorkerResponse = { id: request.id, ok: true, text, pages }
      port.postMessage(response)
    },
    (error: unknown) => {
      const response: PdfTextWorkerResponse = {
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      }
      port.postMessage(response)
    }
  )
})
