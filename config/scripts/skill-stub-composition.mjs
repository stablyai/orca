// Why: the resolver ladder, the placeholder rule, the no-guessing paragraph, and the
// older-binary fallback frame are byte-identical in every discovery stub and had already
// drifted wherever they were re-authored. One fragment owns them; each per-topic stub only
// marks where they land.
const SHARED_STUB_SOURCE = 'skill-stubs/_shared/cli-resolution.md'
const BLOCK_DEFINITION_PATTERN = /^<!-- block: (?<id>[a-z][a-z0-9-]*)(?<reflow> reflow)? -->$/u
const INSERTION_MARKER_PATTERN = /^<!-- shared: (?<id>\S+) -->$/u
const TOPIC_PLACEHOLDER = '{{topic}}'
// Why: the stub corpus is hand-wrapped at 92 columns. A topic-substituted paragraph must
// re-wrap to that width, or every topic ships a differently ragged copy of one sentence.
const REFLOW_WIDTH = 92

function countBackticks(text) {
  let count = 0
  for (const character of text) {
    if (character === '`') {
      count += 1
    }
  }
  return count
}

// Why: a backticked command must never be split across lines, so a code span is one token.
function atomicTokens(text, sourcePath) {
  const tokens = []
  let span = null
  for (const word of text.split(/\s+/u)) {
    if (!word) {
      continue
    }
    if (span !== null) {
      span += ` ${word}`
      if (countBackticks(span) % 2 === 0) {
        tokens.push(span)
        span = null
      }
      continue
    }
    if (countBackticks(word) % 2 === 1) {
      span = word
      continue
    }
    tokens.push(word)
  }
  if (span !== null) {
    throw new Error(`Shared stub block has an unclosed code span: ${sourcePath}`)
  }
  return tokens
}

function reflowParagraph(text, sourcePath) {
  const lines = []
  let current = ''
  for (const token of atomicTokens(text, sourcePath)) {
    if (!current) {
      current = token
    } else if (current.length + 1 + token.length <= REFLOW_WIDTH) {
      current += ` ${token}`
    } else {
      lines.push(current)
      current = token
    }
  }
  if (current) {
    lines.push(current)
  }
  return lines.join('\n')
}

// Lines before the first `<!-- block: -->` are the fragment's own header comment and are
// not projected. Input must already be LF-normalized.
function parseSharedStubBlocks(markdown, sourcePath) {
  const blocks = new Map()
  let open = null
  const close = () => {
    if (!open) {
      return
    }
    const text = open.lines.join('\n').replace(/^\n+/u, '').replace(/\n+$/u, '')
    if (!text) {
      throw new Error(`Shared stub block is empty: ${sourcePath} (${open.id})`)
    }
    blocks.set(open.id, { text, reflow: open.reflow })
  }
  for (const line of markdown.split('\n')) {
    const definition = BLOCK_DEFINITION_PATTERN.exec(line)
    if (!definition) {
      if (open) {
        open.lines.push(line)
      }
      continue
    }
    close()
    const { id, reflow } = definition.groups
    if (blocks.has(id)) {
      throw new Error(`Shared stub block is defined twice: ${sourcePath} (${id})`)
    }
    open = { id, reflow: Boolean(reflow), lines: [] }
  }
  close()
  if (blocks.size === 0) {
    throw new Error(`Shared stub source defines no blocks: ${sourcePath}`)
  }
  return blocks
}

function renderBlock(block, topic, sourcePath) {
  const text = block.text.replaceAll(TOPIC_PLACEHOLDER, topic)
  return block.reflow ? reflowParagraph(text, sourcePath) : text
}

// Why: an insertion that silently vanished would let a stub drop the safety ladder while the
// generator stayed green, so an unknown marker and a missing or repeated insertion both throw.
function renderSharedStubBody(stubBody, { topic, blocks, sourcePath }) {
  const insertions = new Map()
  const composed = stubBody
    .split('\n')
    .map((line) => {
      const marker = INSERTION_MARKER_PATTERN.exec(line)
      if (!marker) {
        return line
      }
      const { id } = marker.groups
      const block = blocks.get(id)
      if (!block) {
        throw new Error(
          `Unknown shared stub block "${id}" in ${sourcePath}. Known blocks: ${[...blocks.keys()].join(', ')}`
        )
      }
      insertions.set(id, (insertions.get(id) ?? 0) + 1)
      return renderBlock(block, topic, SHARED_STUB_SOURCE)
    })
    .join('\n')

  for (const [id, block] of blocks) {
    const count = insertions.get(id) ?? 0
    if (count !== 1) {
      throw new Error(
        `${sourcePath} must insert <!-- shared: ${id} --> exactly once; found ${count}.`
      )
    }
    // Why: re-inlining a copy beside the marker is exactly the drift this fragment ends.
    const [firstLine] = renderBlock(block, topic, SHARED_STUB_SOURCE).split('\n')
    if (stubBody.includes(firstLine)) {
      throw new Error(
        `${sourcePath} re-inlines shared block "${id}"; insert it with a marker instead.`
      )
    }
  }
  if (composed.includes(TOPIC_PLACEHOLDER)) {
    throw new Error(`Shared stub block left an unsubstituted placeholder in ${sourcePath}.`)
  }
  return composed
}

export {
  REFLOW_WIDTH,
  SHARED_STUB_SOURCE,
  parseSharedStubBlocks,
  reflowParagraph,
  renderSharedStubBody
}
