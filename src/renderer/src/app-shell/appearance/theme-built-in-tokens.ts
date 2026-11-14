import { PLUGIN_APP_THEME_TOKENS } from '../../../../shared/plugins/artifacts/plugin-theme-artifact'

const cache = new Map<'light' | 'dark', Record<string, string>>()

function collectStyle(style: CSSStyleDeclaration, into: Map<string, string>): void {
  for (const name of Array.from(style)) {
    if (name.startsWith('--')) {
      into.set(name, style.getPropertyValue(name))
    }
  }
}

/** Custom properties declared by `:root` (light) or `.dark` rules, in stylesheet order. */
function collectDeclarations(
  rules: CSSRuleList,
  selector: ':root' | '.dark',
  into: Map<string, string>
): void {
  for (const rule of Array.from(rules)) {
    if (rule instanceof CSSStyleRule) {
      if (rule.selectorText.split(',').some((part) => part.trim() === selector)) {
        collectStyle(rule.style, into)
        // Why: declarations after a nested rule parse as their own nested-declarations rules.
        for (const nested of Array.from(rule.cssRules)) {
          if (nested instanceof CSSNestedDeclarations) {
            collectStyle(nested.style, into)
          }
        }
      }
    } else if (rule instanceof CSSLayerBlockRule || rule instanceof CSSSupportsRule) {
      // Why not media rules: a rule for another screen or scheme is not this mode's built-in.
      collectDeclarations(rule.cssRules, selector, into)
    }
  }
}

function declarationsFor(mode: 'light' | 'dark'): Map<string, string> {
  const declarations = new Map<string, string>()
  const selectors: (':root' | '.dark')[] = mode === 'dark' ? [':root', '.dark'] : [':root']
  for (const selector of selectors) {
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        collectDeclarations(sheet.cssRules, selector, declarations)
      } catch {
        // A cross-origin sheet cannot be read; Orca's own sheets always can.
      }
    }
  }
  return declarations
}

/**
 * Orca's own public token values for a mode, whichever mode is painted now: the stylesheet's
 * declarations are resolved on a detached probe element, so nothing repaints or flips.
 */
export function themeBuiltInTokens(mode: 'light' | 'dark'): Record<string, string> {
  const cached = cache.get(mode)
  if (cached) {
    return cached
  }
  const probe = document.createElement('div')
  probe.style.display = 'none'
  // Why reset first: a token no rule declares would otherwise inherit the theme painted on <html>.
  for (const token of [...PLUGIN_APP_THEME_TOKENS, '--callout-note']) {
    probe.style.setProperty(token, 'initial')
  }
  for (const [name, value] of declarationsFor(mode)) {
    probe.style.setProperty(name, value)
  }
  document.body.appendChild(probe)
  const style = getComputedStyle(probe)
  const read = (token: string): string => style.getPropertyValue(token).trim()
  const builtIns = {
    ...Object.fromEntries(PLUGIN_APP_THEME_TOKENS.map((token) => [token, read(token)])),
    // Why: chat paints an omitted link color as --callout-note, as documentBuiltIns reads it.
    '--text-link': read('--text-link') || read('--callout-note')
  }
  probe.remove()
  cache.set(mode, builtIns)
  return builtIns
}
