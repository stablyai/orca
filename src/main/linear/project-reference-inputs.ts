/**
 * The same reference typed twice costs one workspace lookup each, so every
 * resolver folds its inputs first. The host cannot rely on a client having done
 * this: the SSH shim forwards repeated flags exactly as they were typed.
 */
export function dedupeLinearReferenceInputs(inputs: readonly string[]): string[] {
  const seen = new Set<string>()
  const unique: string[] = []
  for (const input of inputs) {
    const trimmed = input.trim()
    const key = trimmed.toLowerCase()
    if (!trimmed || seen.has(key)) {
      continue
    }
    seen.add(key)
    unique.push(trimmed)
  }
  return unique
}
