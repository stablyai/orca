// A PDF's text, extracted here so the file never goes to another service. Loaded only when a PDF
// is read, since the PDF reader is large.

/** Each page's text, pages separated by a marked line. */
export async function pdfText(data: Uint8Array): Promise<{ text: string; pages: number }> {
  // The reader runs its worker in this thread when the worker's module is already loaded.
  if (!Reflect.has(globalThis, 'pdfjsWorker')) {
    Reflect.set(globalThis, 'pdfjsWorker', await import('pdfjs-dist/legacy/build/pdf.worker.mjs'))
  }
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const task = pdfjs.getDocument({
    data,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0
  })
  const doc = await task.promise
  try {
    const pages: string[] = []
    for (let number = 1; number <= doc.numPages; number++) {
      const page = await doc.getPage(number)
      const content = await page.getTextContent()
      const line = content.items
        .map((item) => ('str' in item ? `${item.str}${item.hasEOL ? '\n' : ''}` : ''))
        .join('')
      pages.push(`--- page ${number} ---\n${line.trim()}`)
    }
    return { text: pages.join('\n\n'), pages: doc.numPages }
  } finally {
    await task.destroy()
  }
}
