import { sep } from 'node:path'

export function joinLeafPath(dir: string, leaf: string): string {
  const len = dir.length
  if (len === 0) {
    return leaf
  }
  const last = dir.charCodeAt(len - 1)
  if (last === 0x2f || (sep === '\\' && last === 0x5c)) {
    return `${dir}${leaf}`
  }
  return `${dir}${sep}${leaf}`
}

function isAsciiWhitespace(b: number): boolean {
  return b === 0x20 || (b >= 0x09 && b <= 0x0d)
}

/** Decode a UTF-8 Buffer with JS `.trim()` semantics without allocating an untrimmed string first. */
export function decodeTrimmedUtf8Buffer(buf: Buffer): string {
  let start = 0
  let end = buf.length
  while (start < end && isAsciiWhitespace(buf[start])) {
    start += 1
  }
  while (end > start && isAsciiWhitespace(buf[end - 1])) {
    end -= 1
  }
  if (start === end) {
    return ''
  }
  const text = buf.toString('utf8', start, end)
  return buf[start] >= 0x80 || buf[end - 1] >= 0x80 ? text.trim() : text
}

const REFS_HEADS_PREFIX = Buffer.from('refs/heads/', 'ascii')

function bufferStartsWithAt(buf: Buffer, offset: number, end: number, prefix: Buffer): boolean {
  const len = prefix.length
  if (end - offset < len) {
    return false
  }
  for (let i = 0; i < len; i += 1) {
    if (buf[offset + i] !== prefix[i]) {
      return false
    }
  }
  return true
}

function bufferSliceEqualsBytes(
  buf: Buffer,
  start: number,
  end: number,
  expected: Buffer
): boolean {
  const len = expected.length
  if (end - start !== len) {
    return false
  }
  for (let i = 0; i < len; i += 1) {
    if (buf[start + i] !== expected[i]) {
      return false
    }
  }
  return true
}

export type PackedRefsLookup = {
  get(ref: string): string | undefined
}

const EMPTY_PACKED_REFS_LOOKUP: PackedRefsLookup = {
  get: () => undefined
}

export function emptyPackedRefsLookup(): PackedRefsLookup {
  return EMPTY_PACKED_REFS_LOOKUP
}

function scanPackedRefFromBuffer(buf: Buffer, targetRef: string): string | undefined {
  const targetBytes = Buffer.from(targetRef, 'utf8')
  const len = buf.length
  let lineStart = 0
  while (lineStart < len && isAsciiWhitespace(buf[lineStart])) {
    lineStart += 1
  }
  let matchedOid: string | undefined
  while (lineStart < len) {
    const nextNewline = buf.indexOf(0x0a, lineStart)
    const lineEnd = nextNewline === -1 ? len : nextNewline
    if (lineEnd > lineStart) {
      const firstByte = buf[lineStart]
      if (firstByte !== 0x23 && firstByte !== 0x5e) {
        const separator = buf.indexOf(0x20, lineStart)
        if (separator > lineStart && separator < lineEnd) {
          let refStart = separator + 1
          let refEnd = lineEnd
          while (refStart < refEnd && buf[refStart] <= 0x20) {
            refStart += 1
          }
          while (refEnd > refStart && buf[refEnd - 1] <= 0x20) {
            refEnd -= 1
          }
          if (bufferSliceEqualsBytes(buf, refStart, refEnd, targetBytes)) {
            matchedOid = buf.toString('utf8', lineStart, separator)
          }
        }
      }
    }
    lineStart = nextNewline === -1 ? len : nextNewline + 1
  }
  return matchedOid
}

/**
 * Build a packed-refs lookup optimized for worktree HEAD resolution: indexes only `refs/heads/*`
 * in a single pass (skipping tens of thousands of remote/tag refs) and scans on demand for any
 * other ref namespace.
 */
export function createPackedRefsLookup(buf: Buffer): PackedRefsLookup {
  const heads = new Map<string, string>()
  const len = buf.length
  let lineStart = 0
  while (lineStart < len && isAsciiWhitespace(buf[lineStart])) {
    lineStart += 1
  }
  while (lineStart < len) {
    const nextNewline = buf.indexOf(0x0a, lineStart)
    const lineEnd = nextNewline === -1 ? len : nextNewline
    if (lineEnd > lineStart) {
      const firstByte = buf[lineStart]
      // Skip '#' (0x23) comment lines and '^' (0x5e) peeled-tag lines without decoding.
      if (firstByte !== 0x23 && firstByte !== 0x5e) {
        const separator = buf.indexOf(0x20, lineStart)
        if (separator > lineStart && separator < lineEnd) {
          let refStart = separator + 1
          let refEnd = lineEnd
          while (refStart < refEnd && buf[refStart] <= 0x20) {
            refStart += 1
          }
          while (refEnd > refStart && buf[refEnd - 1] <= 0x20) {
            refEnd -= 1
          }
          if (bufferStartsWithAt(buf, refStart, refEnd, REFS_HEADS_PREFIX)) {
            heads.set(
              buf.toString('utf8', refStart, refEnd),
              buf.toString('utf8', lineStart, separator)
            )
          }
        }
      }
    }
    lineStart = nextNewline === -1 ? len : nextNewline + 1
  }
  let otherRefsCache: Map<string, string | undefined> | undefined
  return {
    get(ref: string): string | undefined {
      if (ref.startsWith('refs/heads/')) {
        return heads.get(ref)
      }
      if (otherRefsCache?.has(ref)) {
        return otherRefsCache.get(ref)
      }
      const oid = scanPackedRefFromBuffer(buf, ref)
      ;(otherRefsCache ??= new Map()).set(ref, oid)
      return oid
    }
  }
}

/** Parse git `packed-refs` directly from a UTF-8 Buffer without decoding or trimming the whole file. */
export function parsePackedRefsBuffer(buf: Buffer): Map<string, string> {
  const refs = new Map<string, string>()
  const len = buf.length
  let lineStart = 0
  while (lineStart < len && isAsciiWhitespace(buf[lineStart])) {
    lineStart += 1
  }
  while (lineStart < len) {
    const nextNewline = buf.indexOf(0x0a, lineStart)
    const lineEnd = nextNewline === -1 ? len : nextNewline
    if (lineEnd > lineStart) {
      const firstByte = buf[lineStart]
      // Skip '#' (0x23) comment lines and '^' (0x5e) peeled-tag lines without decoding.
      if (firstByte !== 0x23 && firstByte !== 0x5e) {
        const separator = buf.indexOf(0x20, lineStart)
        if (separator > lineStart && separator < lineEnd) {
          let refStart = separator + 1
          let refEnd = lineEnd
          while (refStart < refEnd && buf[refStart] <= 0x20) {
            refStart += 1
          }
          while (refEnd > refStart && buf[refEnd - 1] <= 0x20) {
            refEnd -= 1
          }
          refs.set(
            buf.toString('utf8', refStart, refEnd),
            buf.toString('utf8', lineStart, separator)
          )
        }
      }
    }
    lineStart = nextNewline === -1 ? len : nextNewline + 1
  }
  return refs
}

/** Parse git `packed-refs` content line-by-line without allocating a `split('\n')` array. */
export function parsePackedRefsContent(content: string): Map<string, string> {
  const refs = new Map<string, string>()
  const len = content.length
  let lineStart = 0
  while (lineStart < len) {
    const nextNewline = content.indexOf('\n', lineStart)
    const lineEnd = nextNewline === -1 ? len : nextNewline
    if (lineEnd > lineStart) {
      const firstCode = content.charCodeAt(lineStart)
      // Skip '#' (35) comment lines and '^' (94) peeled-tag lines without slicing.
      if (firstCode !== 35 && firstCode !== 94) {
        const separator = content.indexOf(' ', lineStart)
        if (separator > lineStart && separator < lineEnd) {
          let refStart = separator + 1
          let refEnd = lineEnd
          while (refStart < refEnd && content.charCodeAt(refStart) <= 32) {
            refStart += 1
          }
          while (refEnd > refStart && content.charCodeAt(refEnd - 1) <= 32) {
            refEnd -= 1
          }
          refs.set(content.slice(refStart, refEnd), content.slice(lineStart, separator))
        }
      }
    }
    lineStart = nextNewline === -1 ? len : nextNewline + 1
  }
  return refs
}

// Repo-authored ref names must reject Windows separators/drive syntax before joining filesystem paths.
export function isSafeRefName(ref: string): boolean {
  const len = ref.length
  if (len === 0 || ref.includes('\\') || ref.includes(':')) {
    return false
  }
  let start = 0
  while (start <= len) {
    const slash = ref.indexOf('/', start)
    const end = slash === -1 ? len : slash
    const partLen = end - start
    if (
      partLen === 0 ||
      (partLen === 2 && ref.charCodeAt(start) === 46 && ref.charCodeAt(start + 1) === 46)
    ) {
      return false
    }
    if (slash === -1) {
      break
    }
    start = slash + 1
  }
  return true
}
