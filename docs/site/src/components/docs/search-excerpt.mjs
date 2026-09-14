const HIGHLIGHT_TAG_PATTERN = /<\/?mark>/gi
const HIGHLIGHT_TOKEN_PATTERN = /\0orca-search-highlight-(\d+)\0/g
const CODE_TOKEN_PATTERN = /\0orca-search-code-(\d+)\0/g

function highlightToken(index) {
  return `\0orca-search-highlight-${index}\0`
}

function codeToken(index) {
  return `\0orca-search-code-${index}\0`
}

/**
 * @param {string} value
 * @returns {string}
 */
export function stripSearchExcerptMarkdown(value) {
  const highlightTags = []
  const codeSpans = []
  const protectedHighlights = value.replace(HIGHLIGHT_TAG_PATTERN, (tag) => {
    highlightTags.push(tag)
    return highlightToken(highlightTags.length - 1)
  })
  const protectedCode = protectedHighlights.replace(/(`+)([\s\S]*?)\1/g, (_match, _ticks, code) => {
    codeSpans.push(code)
    return codeToken(codeSpans.length - 1)
  })
  const stripped = protectedCode
    .replace(/!\[([^\]]*)\]\((?:\\.|[^)])*\)/g, '$1')
    .replace(/\[([^\]]+)\]\((?:\\.|[^)])*\)/g, '$1')
    .replace(/\[([^\]]+)\]\s*\[[^\]]*\]/g, '$1')
    .replace(/\[\[([^|\]]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/(^|[^\w])\*([^\s*][^*]*?\S)\*(?!\w)/g, '$1$2')
    .replace(/(^|[^\w])_([^\s_][^_]*?\S)_(?!\w)/g, '$1$2')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1')
    .replace(/\\([\\`*_[\]{}()#+.!_>~-])/g, '$1')
    .replace(CODE_TOKEN_PATTERN, (_match, index) => codeSpans[Number(index)] ?? '')

  return stripped.replace(
    HIGHLIGHT_TOKEN_PATTERN,
    (_match, index) => highlightTags[Number(index)] ?? ''
  )
}
