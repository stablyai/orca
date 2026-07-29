#!/usr/bin/env node
// Benchmark: cost of validating an agent-status payload on every hook event.
//
// 13 of the 15 per-source normalizers in agent-hook-listener.ts built a plain
// object, JSON.stringify'd it, and handed the string to parseAgentStatusPayload,
// which runs assertJsonTextStructureWithinLimits (a per-character scan of the
// WHOLE serialized string) plus JSON.parse — only to reach the same
// normalizeAgentStatusObject the object path calls directly. Claude and Codex
// were already converted, with a comment calling the round trip "pure overhead
// on this hot per-hook path"; the other 13 were not.
//
// Why the gap widens with payload size: the direct path's field normalizer stops
// at the field cap (`normalized.length < maxLength`), so it is O(cap). The round
// trip is O(input) — and the input is bounded only by the 1 MB hook request
// limit, since tool_response text is passed through uncapped for most sources.
//
// Amplifier this models in the second table: resolveToolState stores the raw
// value in lastToolByPaneKey and inherits it until a turn reset, so one large
// tool result is re-serialized and re-scanned on every later event of the turn.
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

const TYPES_SOURCE = readFileSync(
  fileURLToPath(new URL('../../src/shared/agent-status-types.ts', import.meta.url)),
  'utf8'
)

function readMirroredConstant(name) {
  const match = TYPES_SOURCE.match(new RegExp(`${name}\\s*=\\s*([0-9_]+)`))
  if (!match) {
    throw new Error(`agent-status-types.ts no longer defines ${name}; re-sync this benchmark.`)
  }
  return Number(match[1].replaceAll('_', ''))
}

// Read the cap the direct path clamps at, so a drifted value fails loudly here
// instead of quietly changing what this benchmark claims.
const ASSISTANT_MESSAGE_CAP = readMirroredConstant('AGENT_STATUS_ASSISTANT_MESSAGE_MAX_LENGTH')

const ITERATIONS = Number.parseInt(process.env.ORCA_HOOK_NORM_BENCH_ITERATIONS ?? '400', 10)
const WARMUP = Number.parseInt(process.env.ORCA_HOOK_NORM_BENCH_WARMUP ?? '200', 10)

for (const [name, value] of [
  ['ORCA_HOOK_NORM_BENCH_ITERATIONS', ITERATIONS],
  ['ORCA_HOOK_NORM_BENCH_WARMUP', WARMUP]
]) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, received ${value}`)
  }
}

const STRUCTURAL_TOKENS = 4096
const NESTING_DEPTH = 16

// Mirror of assertJsonTextStructureWithinLimits — the per-character scan the
// round trip pays before JSON.parse even starts.
function scanJsonStructure(content) {
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
    if (structuralTokens > STRUCTURAL_TOKENS) {
      throw new Error('structuralTokens')
    }
    if (character === '{' || character === '[') {
      depth += 1
      if (depth > NESTING_DEPTH) {
        throw new Error('nestingDepth')
      }
    } else if (character === '}' || character === ']') {
      depth = Math.max(0, depth - 1)
    }
  }
}

// Mirror of the field normalizer's bounded walk: it stops consuming at the cap.
function normalizeField(value, maxLength) {
  if (typeof value !== 'string') {
    return undefined
  }
  let normalized = ''
  let newlineRun = 0
  for (let index = 0; index < value.length && normalized.length < maxLength; index += 1) {
    const code = value.charCodeAt(index)
    if (code === 13 || code === 10 || code === 0x2028 || code === 0x2029) {
      if (code === 13 && value.charCodeAt(index + 1) === 10) {
        index += 1
      }
      if (newlineRun < 2) {
        normalized += '\n'
      }
      newlineRun += 1
      continue
    }
    newlineRun = 0
    normalized += value[index]
  }
  return normalized
}

function normalizeObject(payload) {
  return {
    state: payload.state,
    prompt: normalizeField(payload.prompt, ASSISTANT_MESSAGE_CAP),
    agentType: payload.agentType,
    toolName: normalizeField(payload.toolName, ASSISTANT_MESSAGE_CAP),
    toolInput: normalizeField(payload.toolInput, ASSISTANT_MESSAGE_CAP),
    lastAssistantMessage: normalizeField(payload.lastAssistantMessage, ASSISTANT_MESSAGE_CAP)
  }
}

// Pre-fix: serialize, scan every character, parse, then normalize.
function validateViaRoundTrip(payload) {
  const json = JSON.stringify(payload)
  scanJsonStructure(json)
  return normalizeObject(JSON.parse(json))
}

// Post-fix: normalize the object that is already in hand.
function validateDirect(payload) {
  return normalizeObject(payload)
}

function makePayload(messageBytes) {
  return {
    state: 'working',
    prompt: 'do the thing',
    agentType: 'grok',
    toolName: 'shell_command',
    toolInput: 'ls -la',
    lastAssistantMessage: 'x'.repeat(messageBytes)
  }
}

function measure(fn, payload) {
  for (let index = 0; index < WARMUP; index += 1) {
    fn(payload)
  }
  const samples = []
  for (let round = 0; round < 5; round += 1) {
    const start = performance.now()
    for (let index = 0; index < ITERATIONS; index += 1) {
      fn(payload)
    }
    samples.push((performance.now() - start) / ITERATIONS)
  }
  samples.sort((a, b) => a - b)
  return samples[2]
}

const rows = []
for (const kb of [4, 16, 64, 256]) {
  const payload = makePayload(kb * 1024)
  const before = validateViaRoundTrip(payload)
  const after = validateDirect(payload)
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error(`normalizer mismatch at ${kb} KB`)
  }
  rows.push({
    label: `${kb} KB`,
    beforeUs: measure(validateViaRoundTrip, payload) * 1000,
    afterUs: measure(validateDirect, payload) * 1000
  })
}

const pad = (value, width) => String(value).padStart(width)
console.log('Agent-status payload validation, per hook event')
console.log(
  `field cap=${ASSISTANT_MESSAGE_CAP} iterations=${ITERATIONS} warmup=${WARMUP} (median of 5 rounds)`
)
console.log(
  `${pad('payload', 9)} ${pad('round trip', 12)} ${pad('direct', 10)} ${pad('speedup', 9)}`
)
for (const row of rows) {
  console.log(
    `${pad(row.label, 9)} ${pad(`${row.beforeUs.toFixed(1)} us`, 12)} ${pad(`${row.afterUs.toFixed(1)} us`, 10)} ${pad(`${(row.beforeUs / row.afterUs).toFixed(1)}x`, 9)}`
  )
}

// A single large tool result is inherited across the turn, so every later event
// re-pays the round trip on bytes that were already validated once.
const TURN_EVENTS = 20
const inherited = makePayload(200 * 1024)
const beforeTurnMs = (measure(validateViaRoundTrip, inherited) * TURN_EVENTS).toFixed(2)
const afterTurnMs = (measure(validateDirect, inherited) * TURN_EVENTS).toFixed(2)
console.log(
  `\nOne 200 KB tool result, inherited across ${TURN_EVENTS} later events in the same turn:` +
    `\n  round trip ${beforeTurnMs} ms total   direct ${afterTurnMs} ms total`
)
console.log(
  '\nThe direct path is flat because the field normalizer stops at the cap; the\nround trip is linear in the raw payload, which is bounded only by the 1 MB\nhook request limit.'
)
