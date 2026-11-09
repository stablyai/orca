// Whisper Tiny's greedy decode repeats the last sentence when a 30s window is mostly silence (#23891).
// Three or more copies in a row collapse to one, including a clipped tail that is still a prefix of that sentence.
// Two copies stay, so a sentence the speaker actually said twice is kept. Silence itself is not trimmed.

export function collapseHallucinatedRepeats(text: string): string {
  const sentences = text.match(/[^.!?]+[.!?]*/g) ?? [text]
  const runs: string[][] = []
  for (const raw of sentences) {
    const trimmed = raw.trim()
    const run = runs.at(-1)
    const runHead = run?.[0]?.trim()
    if (run && trimmed && runHead && (trimmed === runHead || runHead.startsWith(trimmed))) {
      run.push(raw)
    } else {
      runs.push([raw])
    }
  }
  return runs
    .map((run) => (run.length >= 3 ? run[0] : run.join('')))
    .join('')
    .trim()
}
