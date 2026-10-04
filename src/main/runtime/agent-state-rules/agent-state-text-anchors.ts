import type { RuntimeTerminalWaitBlockedReason } from '../../../shared/runtime-types'
import { startOfLastLines } from '../terminal-wait-tail-window'
import { compileTextTest, type TextMatcher } from './agent-state-rule-matchers'
import { compiledFromActiveAgentStateRules } from './active-agent-state-rules'
import type {
  Anchor,
  AgentStateRulesFile,
  NamedTextAnchor,
  TextAnchorCondition
} from './agent-state-rules-schema'
import { findAntigravityComposerIndex } from './antigravity-text-composer'

export type BlockedTextSignal = { reason: RuntimeTerminalWaitBlockedReason; index: number }

type TextAnchorHit = { answer: Anchor['answer']; index: number }

export type TextAnchorFinder = (normalized: string) => TextAnchorHit | null

const NAMED_TEXT_ANCHOR_FINDERS: Record<NamedTextAnchor, (normalized: string) => number | null> = {
  'antigravity-text-composer': findAntigravityComposerIndex
}

function compileFind(find: TextAnchorCondition['find']): (text: string) => number | null {
  if ('predicate' in find) {
    return NAMED_TEXT_ANCHOR_FINDERS[find.predicate]
  }
  return (text) => {
    const index = text.lastIndexOf(find.lastOf)
    return index === -1 ? null : index
  }
}

function compileLineCount(lines: NonNullable<TextAnchorCondition['lines']>): TextMatcher {
  const test = compileTextTest(lines.test)
  return (text) => {
    const rows = text.split('\n')
    while (rows.length > 0 && rows.at(-1)?.trim() === '') {
      rows.pop()
    }
    return (
      rows.filter(test).length >= lines.atLeast && (!lines.includingLast || test(rows.at(-1) ?? ''))
    )
  }
}

export function compileTextAnchor(
  when: TextAnchorCondition,
  answer: Anchor['answer']
): TextAnchorFinder {
  const { withinLastLines } = when
  const find = compileFind(when.find)
  const after = when.after ? compileTextTest(when.after) : null
  const lines = when.lines ? compileLineCount(when.lines) : null
  return (text) => {
    const start = withinLastLines ? startOfLastLines(text, withinLastLines) : 0
    const region = text.slice(start)
    const index = find(region)
    if (index === null || (after && !after(region.slice(index))) || (lines && !lines(region))) {
      return null
    }
    return { answer, index: start + index }
  }
}

type TextAnchor = { when: TextAnchorCondition; answer: Anchor['answer'] }

function textAnchorsOf(files: readonly AgentStateRulesFile[]): TextAnchor[] {
  return files.flatMap((file) =>
    file.anchors.flatMap(({ when, answer }) => (when.region === 'text' ? [{ when, answer }] : []))
  )
}

function compileEach(anchors: readonly TextAnchor[]): TextAnchorFinder[] {
  return anchors.map(({ when, answer }) => compileTextAnchor(when, answer))
}

export function compileTextAnchors(files: readonly AgentStateRulesFile[]): {
  blocked: TextAnchorFinder[]
  prompts: TextAnchorFinder[]
  holds: TextAnchorFinder[]
  blockedLiterals: string[]
  screenProbeBanners: string[]
} {
  const anchors = textAnchorsOf(files)
  const blocked = anchors.filter((anchor) => anchor.answer.state === 'blocked')
  return {
    blocked: compileEach(blocked),
    prompts: compileEach(
      anchors.filter(({ answer }) => answer.state !== 'blocked' && answer.state !== 'hold')
    ),
    holds: compileEach(anchors.filter(({ answer }) => answer.state === 'hold')),
    blockedLiterals: blocked.flatMap(({ when }) =>
      'lastOf' in when.find ? [when.find.lastOf] : []
    ),
    screenProbeBanners: files.flatMap((file) => file.profile?.screenProbeBanner ?? [])
  }
}

const textAnchors = compiledFromActiveAgentStateRules(compileTextAnchors)

/** The literal every blocked anchor needs, for the blocked layer's one-pass prefilter. */
export function blockedAnchorLiterals(): readonly string[] {
  return textAnchors().blockedLiterals
}

/** Every rule file's blocked anchor found in the blocked layer's live window. */
export function findBlockedAnchorSignals(window: string): BlockedTextSignal[] {
  return textAnchors().blocked.flatMap((find) => {
    const hit = find(window)
    return hit?.answer.state === 'blocked' ? [{ reason: hit.answer.reason, index: hit.index }] : []
  })
}

/**
 * The latest live prompt (`live`: an idle or live anchor, which proves an earlier startup
 * dialog was answered) and the latest idle one (`ready`) that any rule file's anchors find.
 */
export function findPromptAnchorIndexes(normalized: string): {
  live: number | null
  ready: number | null
} {
  let live: number | null = null
  let ready: number | null = null
  for (const find of textAnchors().prompts) {
    const hit = find(normalized)
    if (hit === null) {
      continue
    }
    live = Math.max(live ?? -1, hit.index)
    if (hit.answer.state === 'idle') {
      ready = Math.max(ready ?? -1, hit.index)
    }
  }
  return { live, ready }
}

/** Whether any rule file's hold anchor shows: an agent is up but not yet taking input. */
export function showsHoldAnchor(normalized: string): boolean {
  return textAnchors().holds.some((find) => find(normalized) !== null)
}

export function showsScreenProbeBanner(text: string): boolean {
  const normalized = text.toLowerCase()
  return textAnchors().screenProbeBanners.some((banner) => normalized.includes(banner))
}
