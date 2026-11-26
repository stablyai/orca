import type MarkdownIt from 'markdown-it'
import type StateInline from 'markdown-it/lib/rules_inline/state_inline.mjs'
import { parseCodexFileCitation } from '../../../../../src/shared/native-chat/file-access/codex-file-citation'
import { createNativeChatFileHref } from '../../../../../src/shared/native-chat/file-access/native-chat-href-routing'

function citationRule(state: StateInline, silent: boolean): boolean {
  const citation = parseCodexFileCitation(state.src, state.pos)
  if (!citation || citation.end > state.posMax) {
    return false
  }
  if (!silent) {
    if (state.linkLevel === 0) {
      state
        .push('link_open', 'a', 1)
        .attrSet('href', createNativeChatFileHref(citation.path, 'literal'))
    }
    state.push('text', '', 0).content = citation.label
    if (state.linkLevel === 0) {
      state.push('link_close', 'a', -1)
    }
  }
  state.pos = citation.end
  return true
}

export function mobileMarkdownCodexFileCitations(markdown: MarkdownIt): void {
  markdown.inline.ruler.before('link', 'codex_file_citation', citationRule)
}
