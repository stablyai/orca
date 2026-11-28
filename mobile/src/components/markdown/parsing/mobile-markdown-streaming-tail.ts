import remend from 'remend'
import { protectCodexFileCitations } from '../../../../../src/shared/native-chat/file-access/codex-file-citation'
import type { Token } from '../blocks/mobile-markdown-code-nodes'
import { mathClosed } from '../math/mobile-markdown-math-nodes'

/** The text with the markup its last top-level block leaves open closed, as desktop closes it.
 *  Only that block: a lone `*` earlier in the reply is no opener, and remend would close it. */
export function withLastBlockClosed(
  source: string,
  tokens: readonly Token[],
  chatMath: boolean
): string {
  const last = tokens.findLast((token) => token.level === 0 && token.map)
  const lastBlock = last?.map?.[0] ?? 0
  const lines = source.split('\n')
  const tail = lines.slice(lastBlock).join('\n')
  // Like desktop, unfinished math stays as typed: remend would rewrite TeX as Markdown.
  const tailTokens = last ? tokens.slice(tokens.indexOf(last)) : []
  if (tailTokens.some((token) => !mathClosed(token)) || (chatMath && /\\[[(]/.test(tail))) {
    return source
  }
  const closed = protectCodexFileCitations(tail, (source) =>
    remend(source, { linkMode: 'text-only', katex: false })
  )
  return closed === tail ? source : [...lines.slice(0, lastBlock), closed].join('\n')
}
