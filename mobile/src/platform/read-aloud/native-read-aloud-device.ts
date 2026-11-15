import * as Speech from 'expo-speech'

// Android refuses an utterance past maxSpeechInputLength, so long text is queued as pieces cut at a line or word break.
export function readAloudPieces(text: string, max: number): string[] {
  const pieces: string[] = []
  let rest = text.trim()
  while (rest.length > max) {
    const lineBreak = rest.lastIndexOf('\n', max)
    const wordBreak = rest.lastIndexOf(' ', max)
    const cut = lineBreak > 0 ? lineBreak : wordBreak > 0 ? wordBreak : max
    pieces.push(rest.slice(0, cut))
    rest = rest.slice(cut).trim()
  }
  return rest ? [...pieces, rest] : pieces
}

export function speakOnDevice(text: string): Promise<void> {
  const pieces = readAloudPieces(text, Speech.maxSpeechInputLength)
  return new Promise((resolve) => {
    if (pieces.length === 0) {
      resolve()
      return
    }
    // Stopping ends the whole queue, so the first stop or error settles it.
    const settle = () => resolve()
    pieces.forEach((piece, index) => {
      Speech.speak(piece, {
        onDone: index === pieces.length - 1 ? settle : undefined,
        onStopped: settle,
        // A failed piece leaves later ones queued; stop them so the reply matches what plays.
        onError: () => {
          stopOnDevice()
          settle()
        }
      })
    })
  })
}

export function stopOnDevice(): void {
  void Speech.stop()
}
