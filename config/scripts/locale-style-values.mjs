// CSS that lives in the i18n catalog. MT rewrote a selector to [データスラッシュメニュー] and a keyframe
// name to ブラウザフラッシュ, breaking the view in that locale only. Removing these from en.json is
// the real fix; until then the policy pins them to English.

const STYLE_BLOCK =
  /@(keyframes|media|supports|font-face)\b|[.#][a-zA-Z][\w-]*[^{}]*\{[^{}]*[a-z-]+\s*:|\[[a-z-]+=["'][^"']*["']\]|\{[^{}]*[a-z-]+\s*:\s*[^{}]*[;}]/

// A selector with no declaration block has no braces for STYLE_BLOCK to key off.
const SELECTOR_TOKEN = /^(?:[>+~]|[a-zA-Z.#[][\w.#:()[\]"'=^$|*-]*)$/
const LONE_SELECTOR = /^#[a-zA-Z][\w-]*$|^\.[a-zA-Z][\w-]*-[\w-]+$/
// One dotted, colon or bracketed token — button.primary, a:hover, wsl.exe, localhost:3000. It is
// code whether it names a selector, a file or a host, and a translation breaks all three.
const LONE_QUALIFIED = /^[a-zA-Z][\w-]*(?:[.#:][\w-]+|\[[^\]]+\])$/

function isStandaloneSelector(enValue) {
  if (/[{}]/.test(enValue)) {
    return false
  }
  const tokens = enValue.trim().split(/\s+/)
  if (!tokens.every((token) => SELECTOR_TOKEN.test(token))) {
    return false
  }
  // A selector join, not a sentence period: two sentences would otherwise clear the threshold.
  const marked = tokens.filter((token) => /^[#.][a-zA-Z]|[\w-][.#:][a-zA-Z]|\[/.test(token))
  if (marked.length >= 2) {
    return true
  }
  return tokens.length === 1 && (LONE_SELECTOR.test(tokens[0]) || LONE_QUALIFIED.test(tokens[0]))
}

export function isStyleValue(enValue) {
  return STYLE_BLOCK.test(enValue) || isStandaloneSelector(enValue)
}
