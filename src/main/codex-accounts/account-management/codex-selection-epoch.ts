// Advances on every write of the Codex account selection; an answer to a restart prompt is bound to
// the epoch it was given in, so B, then A, then B again is a different choice even for the same id.
let selectionEpoch = 0

export function bumpCodexSelectionEpoch(): void {
  selectionEpoch += 1
}

export function getCodexSelectionEpoch(): number {
  return selectionEpoch
}
