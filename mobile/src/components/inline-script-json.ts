// JSON.stringify leaves <,>,&,U+2028/U+2029 raw; escape them as Unicode so </script> cannot terminate inline script.
// These occur only inside JSON strings, so decoding preserves exact WebView text.
export function encodeJsonForScript(json: string): string {
  return json.replace(
    /[<>&\u2028\u2029]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
  )
}

/** A value as a JavaScript literal safe to splice into an inline <script>. */
export function inlineScriptLiteral(value: unknown): string {
  return encodeJsonForScript(JSON.stringify(value))
}
