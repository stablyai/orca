/** A current rendered Hermes frame, never accumulated scrollback. */
export function isHermesReadyPromptSnapshot(screen: string): boolean {
  const visible = screen
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const status = visible.at(-2) ?? ''
  const composer = visible.at(-1) ?? ''
  return (
    visible.some((line) => /\bHermes Agent\b/i.test(line)) &&
    /^[─\s]*ready\s*│/i.test(status) &&
    /^❯(?:\s|$)/u.test(composer)
  )
}
