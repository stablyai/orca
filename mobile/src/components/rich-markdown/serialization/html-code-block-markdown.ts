import { textContent } from './html-inline-markdown'
import { codeFenceFor } from './markdown-code-fence'

/** A PRE as a fenced block, written the same at top level and inside list items. */
export function codeBlockMarkdown(pre: Element): string {
  const language = pre.getAttribute('data-language') ?? ''
  // Drop trailing newlines: browsers leave a placeholder <br> after Enter at the end of a block.
  const code = textContent(pre).replace(/\n+$/, '')
  const fence = codeFenceFor(code)
  return `${fence}${language}\n${code}\n${fence}`
}
