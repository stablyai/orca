// Keep executable resolution and command-discovery guidance consistent across stubs.
const SHARED_STUB_SOURCE = 'skill-stubs/_shared/cli-resolution.md'
const BLOCK_DEFINITION_PATTERN = /^<!-- block: (?<id>[a-z][a-z0-9-]*) -->$/u
const INSERTION_MARKER_PATTERN = /^<!-- shared: (?<id>\S+) -->$/u

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
    blocks.set(open.id, { text })
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
    const { id } = definition.groups
    if (blocks.has(id)) {
      throw new Error(`Shared stub block is defined twice: ${sourcePath} (${id})`)
    }
    open = { id, lines: [] }
  }
  close()
  if (blocks.size === 0) {
    throw new Error(`Shared stub source defines no blocks: ${sourcePath}`)
  }
  return blocks
}

// Why: an insertion that silently vanished would let a stub drop the safety ladder while the
// generator stayed green, so an unknown marker and a missing or repeated insertion both throw.
function renderSharedStubBody(stubBody, { blocks, sourcePath }) {
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
      return block.text
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
    const [firstLine] = block.text.split('\n')
    if (stubBody.includes(firstLine)) {
      throw new Error(
        `${sourcePath} re-inlines shared block "${id}"; insert it with a marker instead.`
      )
    }
  }
  return composed
}

export { SHARED_STUB_SOURCE, parseSharedStubBlocks, renderSharedStubBody }
