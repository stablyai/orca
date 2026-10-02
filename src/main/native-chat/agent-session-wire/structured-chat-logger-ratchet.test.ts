import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { scanSourceTree, stripComments } from '../../../shared/source-scan/source-tree-scan'

/**
 * Structured chat reports a failure it carries on past through the host's logger, and nowhere else.
 *
 * A packaged desktop main process has no console, so a `console.warn` there reaches nobody. An
 * optional `on*Error?` callback compiles fine when a caller forgets it, and the failure is dropped.
 * Both shapes are how failures went missing before the logger was required.
 */

// Paths are '/'-separated on every platform (scanSourceTree normalizes them).
const SCOPE_PREFIXES = [
  'main/native-chat/agent-session-wire/',
  'main/native-chat/agent-session-journal/',
  'main/native-chat/structured-agent-session-',
  'main/claude/claude-structured-',
  'main/codex/codex-structured-',
  'main/runtime/structured-',
  'main/runtime/orchestration/structured-',
  // No trailing dash: the agentSession RPC file itself is `structured-agent-session.ts`.
  'main/runtime/rpc/methods/structured-agent-session',
  'main/runtime/rpc/methods/structured-session-',
  'main/runtime/rpc/methods/orchestration-structured-',
  'main/runtime/rpc/methods/orchestration/worker/structured-worker-'
]

/** Structured chat code whose name does not say so. */
const SCOPE_FILES = new Set([
  // Opened and built only by structured Claude chats.
  'main/claude/claude-stream-json-connection.ts',
  'main/claude/claude-at-rest-commands.ts',
  // Install the structured host before a structured worker's stop or release.
  'main/runtime/rpc/methods/orchestration/worker/worker-stop.ts',
  'main/runtime/rpc/methods/orchestration/worker/worker-release-completion.ts'
])

/** The logger's own sink. */
const CONSOLE_ALLOWED = new Set([
  'main/native-chat/agent-session-wire/structured-agent-session-logger.ts'
])

const WIRE = 'main/native-chat/agent-session-wire/'

/** Optional hooks that change what happens, not whether a failure is reported, by file. */
const BEHAVIORAL_OPTIONAL_HOOKS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  // Hands the refusal to the attach caller that answers the client.
  [`${WIRE}structured-agent-session-attach-flow.ts`, new Set(['onAcquisitionFailed'])],
  [`${WIRE}structured-agent-session-attach-orchestration.ts`, new Set(['onAcquisitionFailed'])],
  // Ends the Claude session whose background-task journal writes failed.
  [
    'main/claude/claude-structured-journal-translation.ts',
    new Set(['onBackgroundTaskJournalFailure'])
  ],
  // Stops the provider whose own journal sink failed; the sink reports the failure itself.
  [`${WIRE}structured-agent-session-event-sink.ts`, new Set(['onFailed'])],
  [`${WIRE}structured-agent-session-event-sink-queue.ts`, new Set(['onFailed'])],
  [`${WIRE}structured-agent-session-host-runtime-state.ts`, new Set(['onEventSinkFailure'])]
])

const CONSOLE_PATTERNS = [
  /\bconsole\s*(?:\?\.|\.)\s*(?:warn|error)\b/g,
  /\bconsole\s*(?:\?\.)?\s*\[\s*['"`](?:warn|error)['"`]\s*\]/g,
  /\{[^}]*\b(?:warn|error)\b[^}]*\}\s*=\s*console\b/g
]

const OPTIONAL_FAILURE_CALLBACK =
  /\b(on(?:[A-Z]\w*)?(?:Error|Errors|Failed|Failure|Failures))\s*\?\s*:/g

function lineOf(code: string, index: number): number {
  return code.slice(0, index).split('\n').length
}

/** `line: what` for each console failure write and each reporting-only optional failure hook. */
export function findStructuredChatLoggerBypasses(
  source: string,
  options: { consoleAllowed?: boolean; behavioralHooks?: ReadonlySet<string> } = {}
): string[] {
  const code = stripComments(source)
  const found: string[] = []
  if (!options.consoleAllowed) {
    for (const pattern of CONSOLE_PATTERNS) {
      for (const match of code.matchAll(pattern)) {
        found.push(`${lineOf(code, match.index)}: ${match[0]}`)
      }
    }
  }
  for (const match of code.matchAll(OPTIONAL_FAILURE_CALLBACK)) {
    if (!options.behavioralHooks?.has(match[1])) {
      found.push(`${lineOf(code, match.index)}: ${match[1]}?`)
    }
  }
  return found
}

function inScope(relativePath: string): boolean {
  return (
    (SCOPE_FILES.has(relativePath) ||
      SCOPE_PREFIXES.some((prefix) => relativePath.startsWith(prefix))) &&
    !relativePath.includes('-test-support')
  )
}

describe('structured chat logger ratchet', () => {
  it('flags console failure writes in every spelling', () => {
    const flagged = [
      `console.warn('x', error)`,
      `console.error('x')`,
      `console?.warn('x')`,
      `console['warn']('x')`,
      `const { warn } = console`
    ]
    for (const source of flagged) {
      expect(findStructuredChatLoggerBypasses(source), source).toHaveLength(1)
    }
  })

  it('flags an optional failure callback, and leaves required and behavioral ones alone', () => {
    expect(findStructuredChatLoggerBypasses('type D = { onError?: (e: unknown) => void }')).toEqual(
      ['1: onError?']
    )
    expect(
      findStructuredChatLoggerBypasses('type D = { onSinkFailed ?: () => void }')
    ).toHaveLength(1)
    expect(findStructuredChatLoggerBypasses('type D = { onFailure?: () => void }')).toHaveLength(1)
    expect(findStructuredChatLoggerBypasses('type D = { onFailed: () => void }')).toEqual([])
    expect(
      findStructuredChatLoggerBypasses('type D = { onAcquisitionFailed?: () => void }', {
        behavioralHooks: new Set(['onAcquisitionFailed'])
      })
    ).toEqual([])
  })

  it('leaves prose, console.log and the logger itself alone', () => {
    expect(findStructuredChatLoggerBypasses('// console.warn used to drop this')).toEqual([])
    expect(findStructuredChatLoggerBypasses(`console.log('x')`)).toEqual([])
    expect(findStructuredChatLoggerBypasses(`console.warn('x')`, { consoleAllowed: true })).toEqual(
      []
    )
  })

  const repoRoot = resolve(__dirname, '..', '..', '..', '..')
  const files = scanSourceTree(join(repoRoot, 'src')).filter(({ relativePath }) =>
    inScope(relativePath)
  )

  it('scans a plausible number of files', () => {
    // A broken root or prefix list would make the guard silently vacuous.
    expect(files.length).toBeGreaterThan(300)
    const scanned = new Set(files.map(({ relativePath }) => relativePath))
    expect([...SCOPE_FILES].filter((path) => !scanned.has(path))).toEqual([])
  })

  it('has no structured chat failure that bypasses the logger', () => {
    const offenders = files.flatMap(({ relativePath, source }) =>
      findStructuredChatLoggerBypasses(source, {
        consoleAllowed: CONSOLE_ALLOWED.has(relativePath),
        behavioralHooks: BEHAVIORAL_OPTIONAL_HOOKS.get(relativePath)
      }).map((hit) => `src/${relativePath}:${hit}`)
    )
    expect(offenders).toEqual([])
  })
})
