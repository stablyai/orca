// A guess is a short sentence; a longer one is not worth a frame to every reader.
const MAX_PROMPT_SUGGESTION_LENGTH = 1000

function isJsonPayload(text: string): boolean {
  if (text[0] !== '{' && text[0] !== '[') {
    return false
  }
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

/** Trimmed text of an agent's guess at the next prompt, or null when it is not one: empty, too
 *  long, or a JSON payload such as a sampler's `{"suggestion":null}` for "no guess". */
export function readPromptSuggestionText(text: unknown): string | null {
  const trimmed = typeof text === 'string' ? text.trim() : ''
  if (!trimmed || trimmed.length > MAX_PROMPT_SUGGESTION_LENGTH || isJsonPayload(trimmed)) {
    return null
  }
  return trimmed
}
