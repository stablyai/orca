#!/usr/bin/env node
// Benchmark: cost of resolving a Command Code turn prompt from the transcript,
// paid on EVERY command-code hook event (PreToolUse/PostToolUse fire once per
// tool call, so many per second during an active agent turn).
//
// Before the fix, readLastCommandCodeUserPromptEntryFromTranscript() read up to
// TRANSCRIPT_MAX_SCAN_BYTES (4 MB) synchronously, decoded it all to a JS string,
// and JSON-parsed EVERY line to the end of the buffer to find the LAST user
// entry — so cost grew with the transcript, which only grows as a session runs.
//
// The fix scans backward from EOF in TRANSCRIPT_CHUNK_BYTES blocks and returns
// on the first user line, the shape the sibling readLastTextFromTranscriptOnce
// already used. The answer sits near EOF in a real session (the current turn's
// prompt precedes only this turn's output), so the scan reads one or two blocks
// instead of the whole file.
//
// Both implementations are mirrored here: node cannot import the .ts source,
// matching the other benchmarks in this directory. Constants are re-read from
// the real module so a drifted cap fails loudly instead of measuring dead code.
import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

const LISTENER_SOURCE = readFileSync(
  fileURLToPath(new URL('../../src/shared/agent-hook-listener.ts', import.meta.url)),
  'utf8'
)

function readMirroredConstant(name) {
  const match = LISTENER_SOURCE.match(new RegExp(`const ${name} = ([^\\n]+)`))
  if (!match) {
    throw new Error(`agent-hook-listener.ts no longer defines ${name}; re-sync this benchmark.`)
  }
  const value = Number(new Function(`return (${match[1]})`)())
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} did not resolve to a positive integer`)
  }
  return value
}

const TRANSCRIPT_CHUNK_BYTES = readMirroredConstant('TRANSCRIPT_CHUNK_BYTES')
const TRANSCRIPT_MAX_SCAN_BYTES = readMirroredConstant('TRANSCRIPT_MAX_SCAN_BYTES')
const EMPTY_REGION = Buffer.alloc(0)
const ITERATIONS = Number.parseInt(process.env.ORCA_CC_SCAN_BENCH_ITERATIONS ?? '150', 10)
const WARMUP = Number.parseInt(process.env.ORCA_CC_SCAN_BENCH_WARMUP ?? '20', 10)

for (const [name, value] of [
  ['ORCA_CC_SCAN_BENCH_ITERATIONS', ITERATIONS],
  ['ORCA_CC_SCAN_BENCH_WARMUP', WARMUP]
]) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, received ${value}`)
  }
}

// Mirror of parseAgentHookJson: the real reader scans a line's structure before
// parsing it, on BOTH sides of this comparison. Omitting it made the pre-fix
// column ~9x too fast and invented a regression that does not exist.
const HOOK_STRUCTURAL_TOKENS = 128 * 1024
const HOOK_NESTING_DEPTH = 64

function assertJsonStructure(content) {
  let structuralTokens = 0
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (character === '\\') {
        escaped = true
      } else if (character === '"') {
        inString = false
      }
      continue
    }
    if (character === '"') {
      inString = true
      continue
    }
    if (
      character !== '{' &&
      character !== '}' &&
      character !== '[' &&
      character !== ']' &&
      character !== ',' &&
      character !== ':'
    ) {
      continue
    }
    structuralTokens += 1
    if (structuralTokens > HOOK_STRUCTURAL_TOKENS) {
      throw new Error('structuralTokens')
    }
    if (character === '{' || character === '[') {
      depth += 1
      if (depth > HOOK_NESTING_DEPTH) {
        throw new Error('nestingDepth')
      }
    } else if (character === '}' || character === ']') {
      depth = Math.max(0, depth - 1)
    }
  }
}

function extractUserPrompt(line) {
  let entry
  try {
    assertJsonStructure(line)
    entry = JSON.parse(line)
  } catch {
    return undefined
  }
  if (typeof entry !== 'object' || entry === null || entry.role !== 'user') {
    return undefined
  }
  const content = entry.content
  if (typeof content === 'string' && content.trim().length > 0) {
    return content
  }
  if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part === 'object' && part !== null) {
        const text = part.text
        if (typeof text === 'string' && text.trim().length > 0) {
          return text
        }
      }
    }
  }
  return undefined
}

// Pre-fix: read the capped window, then parse every line to the end.
function readForward(path) {
  const size = statSync(path).size
  if (size <= 0) {
    return undefined
  }
  const bytesToRead = Math.min(size, TRANSCRIPT_MAX_SCAN_BYTES)
  const position = size - bytesToRead
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(bytesToRead)
    let filled = 0
    while (filled < bytesToRead) {
      const n = readSync(fd, buffer, filled, bytesToRead - filled, position + filled)
      if (n === 0) {
        break
      }
      filled += n
    }
    let text = buffer.subarray(0, filled).toString('utf8')
    if (position > 0) {
      const firstNewline = text.indexOf('\n')
      text = firstNewline === -1 ? '' : text.slice(firstNewline + 1)
    }
    let last
    for (const line of text.split('\n')) {
      const prompt = extractUserPrompt(line.trim())
      if (prompt !== undefined) {
        last = prompt
      }
    }
    return last
  } finally {
    closeSync(fd)
  }
}

function findLastPromptInRegion(region) {
  let lineEnd = region.length
  for (let index = region.length - 1; index >= -1; index--) {
    if (index >= 0 && region[index] !== 0x0a) {
      continue
    }
    const lineStart = index + 1
    if (lineEnd > lineStart) {
      const prompt = extractUserPrompt(region.subarray(lineStart, lineEnd).toString('utf8').trim())
      if (prompt !== undefined) {
        return prompt
      }
    }
    lineEnd = index
  }
  return undefined
}

// Post-fix: walk backward from EOF, return on the first user line. The carry is
// a chunk list, not a re-joined buffer, so one oversized line stays linear.
function readBackward(path) {
  const size = statSync(path).size
  if (size <= 0) {
    return undefined
  }
  const fd = openSync(path, 'r')
  try {
    let carryChunks = []
    let bytesRead = 0
    let scanEnd = size
    while (scanEnd > 0 && bytesRead < TRANSCRIPT_MAX_SCAN_BYTES) {
      const chunkSize = Math.min(
        scanEnd,
        TRANSCRIPT_CHUNK_BYTES,
        TRANSCRIPT_MAX_SCAN_BYTES - bytesRead
      )
      const position = scanEnd - chunkSize
      const buffer = Buffer.alloc(chunkSize)
      let filled = 0
      while (filled < chunkSize) {
        const n = readSync(fd, buffer, filled, chunkSize - filled, position + filled)
        if (n === 0) {
          break
        }
        filled += n
      }
      if (filled < chunkSize) {
        break
      }
      bytesRead += filled
      scanEnd = position
      const firstNewline = buffer.indexOf(0x0a)
      const atStart = position === 0
      let completeRegion
      if (atStart) {
        completeRegion = carryChunks.length === 0 ? buffer : Buffer.concat([buffer, ...carryChunks])
        carryChunks = []
      } else if (firstNewline === -1) {
        completeRegion = EMPTY_REGION
        carryChunks.unshift(buffer)
      } else {
        const afterNewline = buffer.subarray(firstNewline + 1)
        completeRegion =
          carryChunks.length === 0 ? afterNewline : Buffer.concat([afterNewline, ...carryChunks])
        carryChunks = [buffer.subarray(0, firstNewline)]
      }
      if (completeRegion.length > 0) {
        const found = findLastPromptInRegion(completeRegion)
        if (found !== undefined) {
          return found
        }
      }
    }
    return undefined
  } finally {
    closeSync(fd)
  }
}

// A real session: many completed turns, then THIS turn's prompt, then the tool
// output produced since. The prompt therefore sits near EOF.
function writeTranscript(path, priorTurns) {
  const lines = []
  for (let index = 0; index < priorTurns; index += 1) {
    lines.push(
      JSON.stringify({ role: 'user', content: [{ type: 'text', text: `older turn ${index}` }] })
    )
    lines.push(
      JSON.stringify({
        role: 'assistant',
        content: [{ type: 'text', text: `${'assistant output '.repeat(30)}${index}` }]
      })
    )
  }
  lines.push(
    JSON.stringify({ role: 'user', content: [{ type: 'text', text: 'the current prompt' }] })
  )
  for (let index = 0; index < 40; index += 1) {
    lines.push(
      JSON.stringify({
        role: 'assistant',
        content: [{ type: 'text', text: `${'current turn output '.repeat(30)}${index}` }]
      })
    )
  }
  writeFileSync(path, `${lines.join('\n')}\n`)
}

// A turn already in progress: `trailingBytes` of tool output sits between the
// prompt and EOF, which is what the backward scan has to read past.
function writeTranscriptWithTrailing(path, priorTurns, trailingBytes) {
  const lines = []
  for (let index = 0; index < priorTurns; index += 1) {
    lines.push(
      JSON.stringify({ role: 'user', content: [{ type: 'text', text: `older turn ${index}` }] })
    )
    lines.push(
      JSON.stringify({
        role: 'assistant',
        content: [{ type: 'text', text: `${'assistant output '.repeat(30)}${index}` }]
      })
    )
  }
  lines.push(
    JSON.stringify({ role: 'user', content: [{ type: 'text', text: 'the current prompt' }] })
  )
  let written = 0
  let index = 0
  while (written < trailingBytes) {
    const line = JSON.stringify({
      role: 'assistant',
      content: [{ type: 'text', text: `${'current turn output '.repeat(30)}${index}` }]
    })
    lines.push(line)
    written += line.length + 1
    index += 1
  }
  writeFileSync(path, `${lines.join('\n')}\n`)
}

// One tool result larger than many read blocks — the shape with no newline for
// the backward scan to stop on.
function writeTranscriptWithHugeLine(path, lineBytes) {
  const lines = [
    JSON.stringify({ role: 'user', content: [{ type: 'text', text: 'the current prompt' }] }),
    JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(lineBytes) }] })
  ]
  writeFileSync(path, `${lines.join('\n')}\n`)
}

function measure(fn, path) {
  for (let index = 0; index < WARMUP; index += 1) {
    fn(path)
  }
  const samples = []
  for (let round = 0; round < 3; round += 1) {
    const start = performance.now()
    for (let index = 0; index < ITERATIONS; index += 1) {
      fn(path)
    }
    samples.push((performance.now() - start) / ITERATIONS)
  }
  samples.sort((a, b) => a - b)
  return samples[1]
}

const dir = mkdtempSync(join(tmpdir(), 'orca-cc-transcript-bench-'))
try {
  const rows = []
  for (const priorTurns of [250, 1000, 3000, 6000]) {
    const path = join(dir, `transcript-${priorTurns}.jsonl`)
    writeTranscript(path, priorTurns)
    const forward = readForward(path)
    const backward = readBackward(path)
    if (forward !== backward) {
      throw new Error(`prompt mismatch at ${priorTurns} prior turns: ${forward} vs ${backward}`)
    }
    if (backward !== 'the current prompt') {
      throw new Error(`benchmark fixture resolved the wrong prompt: ${backward}`)
    }
    rows.push({
      sizeMb: statSync(path).size / (1024 * 1024),
      beforeMs: measure(readForward, path),
      afterMs: measure(readBackward, path)
    })
  }

  const pad = (value, width) => String(value).padStart(width)
  console.log('Command Code transcript prompt read, per hook event')
  console.log(`iterations=${ITERATIONS} warmup=${WARMUP} (median of 3 rounds)`)
  console.log(
    `${pad('size', 9)} ${pad('before ms', 11)} ${pad('after ms', 10)} ${pad('speedup', 9)}`
  )
  for (const row of rows) {
    console.log(
      `${pad(`${row.sizeMb.toFixed(2)} MB`, 9)} ${pad(row.beforeMs.toFixed(3), 11)} ${pad(row.afterMs.toFixed(3), 10)} ${pad(`${(row.beforeMs / row.afterMs).toFixed(0)}x`, 9)}`
    )
  }
  console.log(
    '\nThe old cost grows with the transcript; the new cost is flat because the\ncurrent turn’s prompt sits near EOF and the scan stops at the first hit.'
  )

  // Worst cases, reported even where the ratio is below 1x. The new cost scales
  // with bytes-AFTER the prompt, so a long turn (many tool calls since the ask)
  // and a single oversized tool result are where the win decays or inverts.
  const worst = []
  for (const trailingKb of [32, 256, 1024, 3072]) {
    const path = join(dir, `trailing-${trailingKb}.jsonl`)
    writeTranscriptWithTrailing(path, 1500, trailingKb * 1024)
    if (readForward(path) !== readBackward(path)) {
      throw new Error(`prompt mismatch at trailing ${trailingKb} KB`)
    }
    worst.push({
      label: `${(trailingKb / 1024).toFixed(2)} MB after prompt`,
      beforeMs: measure(readForward, path),
      afterMs: measure(readBackward, path)
    })
  }
  const hugePath = join(dir, 'huge-line.jsonl')
  writeTranscriptWithHugeLine(hugePath, 3 * 1024 * 1024)
  if (readForward(hugePath) !== readBackward(hugePath)) {
    throw new Error('prompt mismatch on the oversized-line fixture')
  }
  worst.push({
    label: '3 MB single line',
    beforeMs: measure(readForward, hugePath),
    afterMs: measure(readBackward, hugePath)
  })

  console.log('\nWorst cases (win decays as a turn progresses; <1x means slower):')
  console.log(
    `${pad('case', 22)} ${pad('before ms', 11)} ${pad('after ms', 10)} ${pad('ratio', 9)}`
  )
  for (const row of worst) {
    console.log(
      `${pad(row.label, 22)} ${pad(row.beforeMs.toFixed(3), 11)} ${pad(row.afterMs.toFixed(3), 10)} ${pad(`${(row.beforeMs / row.afterMs).toFixed(2)}x`, 9)}`
    )
  }
  console.log(
    '\nThe win shrinks toward parity as output accumulates after the prompt, since\nthe backward scan has to read past all of it. The single-line row is the floor:\nno newline to stop on, so the scan reads the line in blocks and joins once where\nthe old code issued one flat read. Both sides pay the same per-line structure\nscan, and the carry is a chunk list, so cost stays linear either way.'
  )
} finally {
  rmSync(dir, { recursive: true, force: true })
}
