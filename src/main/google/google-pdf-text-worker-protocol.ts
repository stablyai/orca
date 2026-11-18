export type PdfTextWorkerRequest = { id: number; data: Uint8Array }
export type PdfTextWorkerResponse =
  | { id: number; ok: true; text: string; pages: number }
  | { id: number; ok: false; error: string }
