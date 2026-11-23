// Why a short list: only words that read wrong title-cased ("Pr Queue"); a word must match whole.
const ACRONYMS =
  'AI API AWS CD CI CLI CPU CSS CSV DNS GCP GPU HTML HTTP HTTPS ID IO JS JSON K8s LLM MCP OS PDF PR SDK SQL SSH TS TSX UI URI URL VM XML YAML'.split(
    ' '
  )
const SPELLING = new Map(ACRONYMS.map((word) => [word.toLowerCase(), word]))

/** `pr-queue` → "PR Queue": dash-separated words title-cased, known acronyms kept as written. */
export function pluginDisplayNameFromId(id: string): string {
  return id
    .split('-')
    .filter(Boolean)
    .map((word) => SPELLING.get(word.toLowerCase()) ?? word[0].toUpperCase() + word.slice(1))
    .join(' ')
}
