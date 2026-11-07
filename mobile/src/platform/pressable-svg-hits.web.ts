const STYLE_ID = 'orca-pressable-svg-hits'

// A click whose target is an SVG path never reaches a page Pressable's onPress.
// Pressable is a div with tabindex. It sets aria-disabled only when `disabled` is passed,
// and role="button" only when asked. One and two levels covers the icon and a single
// wrapper. Deeper drawings (mermaid, an SVG file preview) stay hittable.
const RULES = `:is([tabindex], [aria-disabled], [role="button"]) > svg,
:is([tabindex], [aria-disabled], [role="button"]) > * > svg,
:is([tabindex], [aria-disabled], [role="button"]) > svg > *,
:is([tabindex], [aria-disabled], [role="button"]) > * > svg > * {
  pointer-events: none;
}`

export function startIgnoringPressableIconHits(): void {
  if (document.getElementById(STYLE_ID) !== null) {
    return
  }
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = RULES
  document.head.append(style)
}
