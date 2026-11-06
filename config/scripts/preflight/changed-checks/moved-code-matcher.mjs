// Split files mark moved code added; exempt diagnostic blocks already verbatim/contiguous in touched base files to avoid demanding unrelated edits.
export function normalizeSourceLine(line) {
  return line.replace(/\s+/g, ' ').trim()
}

export function isMovedCode(highlightedLines, baseBlocks) {
  return createMovedCodeMatcher(baseBlocks)(highlightedLines)
}

export function createMovedCodeMatcher(baseBlocks) {
  // Base-revision blocks stay fixed for the gate run; normalize each visited block once.
  const normalizedBlocks = new Map()
  return (highlightedLines) => matchMovedCode(highlightedLines, baseBlocks, normalizedBlocks)
}

function matchMovedCode(highlightedLines, baseBlocks, normalizedBlocks) {
  const needle = highlightedLines.map(normalizeSourceLine).filter((line) => line !== '')
  if (needle.length === 0) {
    return false
  }
  // Moved diagnostics can extend into changed dependency arrays; require same base anchor, preserved order and near-complete span rather than exact whole-block equality.
  const MIN_COVERAGE = 0.9
  return baseBlocks.some((block) => {
    let haystack = normalizedBlocks.get(block)
    if (!haystack) {
      haystack = block.map(normalizeSourceLine).filter((line) => line !== '')
      normalizedBlocks.set(block, haystack)
    }
    for (let start = 0; start < haystack.length; start += 1) {
      if (haystack[start] !== needle[0]) {
        continue
      }
      let matched = 1
      let cursor = start + 1
      for (let index = 1; index < needle.length && cursor < haystack.length; index += 1) {
        while (cursor < haystack.length && haystack[cursor] !== needle[index]) {
          cursor += 1
        }
        if (cursor < haystack.length) {
          matched += 1
          cursor += 1
        }
      }
      if (matched / needle.length >= MIN_COVERAGE) {
        return true
      }
    }
    return false
  })
}
