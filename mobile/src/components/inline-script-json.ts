// JSON.stringify escapes quotes and control chars but leaves `<`, `>`, `&`, and
// the U+2028/U+2029 line separators raw — so a value containing `</script>` would
// close the inline <script> this is spliced into and let the rest execute as
// markup. These characters only ever appear inside JSON string literals, so
// escaping them to \uXXXX is always valid and always parses back to the exact
// original text inside the WebView.
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
