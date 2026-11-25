// Keep URI arithmetic free of expo-file-system imports so cache consumers and store tests need no native runtime.
export function joinUri(...segments: readonly string[]): string {
  return segments.map((segment) => segment.replace(/\/+$/, '')).join('/')
}
