/** Minimal theme surface for U3 (expanded with named themes in U7). The only
 *  decision callers need today is whether color is allowed. */
export type Theme = {
  useColor: boolean
}

/** Respect the NO_COLOR convention (https://no-color.org): any non-empty value
 *  disables color. Views must stay legible via glyphs/labels when color is off. */
export function resolveTheme(env: NodeJS.ProcessEnv = process.env): Theme {
  const noColor = typeof env.NO_COLOR === 'string' && env.NO_COLOR.length > 0
  return { useColor: !noColor }
}

/** Returns the color name when color is enabled, otherwise undefined so Ink
 *  renders the default foreground. */
export function colorProp<T extends string>(theme: Theme, color: T): T | undefined {
  return theme.useColor ? color : undefined
}
