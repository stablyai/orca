// CSS that lives in the i18n catalog. A style value is code: machine translation rewrote a
// selector to [データスラッシュメニュー], `background:` to `背景:` and a keyframe name to ブラウザフラッシュ,
// breaking the view in that locale only. Removing these from en.json is the real fix; until then
// the repair policy pins them to English.

const STYLE_BLOCK =
  /@(keyframes|media|supports|font-face)\b|[.#][a-zA-Z][\w-]*[^{}]*\{[^{}]*[a-z-]+\s*:|\[[a-z-]+=["'][^"']*["']\]|\{[^{}]*[a-z-]+\s*:\s*[^{}]*[;}]/

// Why: a selector with no declaration block has no braces to key off, so STYLE_BLOCK misses it.
// A value counts as one when every token is selector-shaped and at least two carry a class, id,
// pseudo or attribute — which keeps prose such as "Open Settings > Git and try again." out.
const SELECTOR_TOKEN = /^(?:[>+~]|[a-zA-Z.#[][\w.#:()[\]"'=^$|*-]*)$/
const LONE_SELECTOR = /^#[a-zA-Z][\w-]*$|^\.[a-zA-Z][\w-]*-[\w-]+$/

function isStandaloneSelector(enValue) {
  if (/[{}]/.test(enValue)) {
    return false
  }
  const tokens = enValue.trim().split(/\s+/)
  if (!tokens.every((token) => SELECTOR_TOKEN.test(token))) {
    return false
  }
  // Why: the marker must be a real selector join, not a sentence period — two ordinary sentences
  // ending in `.` would otherwise clear the threshold and freeze prose in English.
  const marked = tokens.filter((token) => /^[#.][a-zA-Z]|[\w-][.#:][a-zA-Z]|\[/.test(token))
  return marked.length >= 2 || (tokens.length === 1 && LONE_SELECTOR.test(tokens[0]))
}

export function isStyleValue(enValue) {
  return STYLE_BLOCK.test(enValue) || isStandaloneSelector(enValue)
}
