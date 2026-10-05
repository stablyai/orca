import { z } from 'zod'
import type { RuntimeTerminalWaitBlockedReason } from '../../../shared/runtime-types'
import type { TuiAgent } from '../../../shared/tui-agent'
import { isTuiAgent } from '../../../shared/tui-agent-config'
import { findUnsafePatternReason } from './agent-state-rule-pattern-safety'

/**
 * One file per agent (`<agent>.json` beside this schema), plus `unknown-pane.json` for panes whose
 * agent Orca does not know. Every object is strict, so a misspelled field rejects the file instead
 * of silently dropping a condition. Every rule and anchor is `when` (a region and what it must
 * show) plus `answer`. Once a version ships, adding a region, predicate or answer bumps
 * `engineVersion`; until then version 1 is still being defined.
 */
export const AGENT_STATE_RULES_ENGINE_VERSION = 1

const MAX_PATTERN_LENGTH = 200
const MAX_RULES = 32
const MAX_ROWS = 12
const MAX_TERMS = 8

const Literal = z.string().min(1).max(MAX_PATTERN_LENGTH)

// Why: these are matched against the lowercased text tail, so an uppercase letter never matches.
const TailLiteral = Literal.refine(
  (text) => text === text.toLowerCase(),
  'must be lowercase: the text tail is lowercased'
)

const SafeRegex = Literal.superRefine((pattern, ctx) => {
  const reason = findUnsafePatternReason(pattern)
  if (reason) {
    ctx.addIssue({ code: 'custom', message: `pattern ${reason}` })
  }
})

/** A test on one row or one text segment: a single term, or every `all`, some `any`, no `none`. */
function textTestSchema(containsLiteral: typeof Literal) {
  const term = z.union([
    z.object({ regex: SafeRegex, ignoreCase: z.boolean().optional() }).strict(),
    z.object({ contains: containsLiteral }).strict()
  ])
  const terms = z.array(term).min(1).max(MAX_TERMS)
  return z.union([
    term,
    z
      .object({ all: terms.optional(), any: terms.optional(), none: terms.optional() })
      .strict()
      .refine((test) => Boolean(test.all ?? test.any ?? test.none), 'needs all, any or none')
  ])
}

const TextTestSchema = textTestSchema(Literal)
const TailTextTestSchema = textTestSchema(TailLiteral)

const RowSchema = z.union([TextTestSchema, z.object({ optional: TextTestSchema }).strict()])

/** The evidence behind a rule, since JSON carries no comments; it ships beside the pattern it explains. */
const Why = z.string().min(1).max(600)

const NAMED_SCREEN_PREDICATES = ['codex-header-ready', 'codex-composer-ready'] as const

/**
 * The screen `profile.screenSource` names. `rows` are consecutive trimmed rows, top-down; the
 * block ends at the bottom-most row, among the last `endsWithinBottom`, that passes the final
 * test, and a row above the screen reads as empty. Or `predicate`: a named engine scan over the
 * lowercased screen, for a shape rows cannot state. With neither, it holds whenever readable.
 */
const ScreenConditionSchema = z
  .object({
    region: z.literal('screen'),
    rows: z.array(RowSchema).min(1).max(MAX_ROWS).optional(),
    endsWithinBottom: z.number().int().min(1).max(MAX_ROWS).optional(),
    noneAbove: TextTestSchema.optional(),
    predicate: z.enum(NAMED_SCREEN_PREDICATES).optional()
  })
  .strict()
  .refine(
    (screen) => screen.rows || (!screen.endsWithinBottom && !screen.noneAbove),
    'endsWithinBottom and noneAbove need rows'
  )
  .refine(
    (screen) => !('optional' in (screen.rows?.at(-1) ?? {})),
    'the last row cannot be optional'
  )
  .refine((screen) => !(screen.rows && screen.predicate), 'rows or a predicate, not both')

/** The pane title's status, as the shared title classifier read it (`lastAgentStatus`). */
const TitleConditionSchema = z
  .object({ region: z.literal('title'), status: z.enum(['idle']) })
  .strict()

/**
 * The text tail: this file's `anchor` (an idle text anchor) is found and settled, meaning no
 * blocker was painted after it and no hold anchor shows anywhere.
 */
const TextConditionSchema = z.object({ region: z.literal('text'), anchor: Literal }).strict()

const RuleConditionSchema = z.discriminatedUnion('region', [
  ScreenConditionSchema,
  TitleConditionSchema,
  TextConditionSchema
])

const RuleAnswerSchema = z.discriminatedUnion('state', [
  z
    .object({
      state: z.literal('idle'),
      /** Strong settles a wait at once; weak only on the poll, once nothing stronger spoke. */
      strength: z.enum(['strong', 'weak']),
      /** Believed only after the output clock has been quiet (agents paint this mid-turn too). */
      requiresQuiet: z.boolean(),
      /** On a pane with no output clock (restored or adopted), quiet cannot be measured: a strong
       *  quiet rule is believed at once there, unless it says `skip` (then it does not apply). */
      withoutClock: z.literal('skip').optional()
    })
    .strict()
    .refine(
      (answer) => !answer.withoutClock || (answer.requiresQuiet && answer.strength === 'strong'),
      'withoutClock is for strong rules that require quiet'
    ),
  // Why hold: the agent's own evidence was readable and said "not ready", which must also shut
  // the weak lanes (a name-only title or quiet process cannot see what the screen refused).
  z.object({ state: z.literal('hold') }).strict()
])

/** One entry in the agent's priority list: highest `priority` first, ties in file order. */
const AgentStateRuleSchema = z
  .object({
    id: Literal,
    why: Why,
    priority: z.number().int().min(0).max(1000),
    when: RuleConditionSchema,
    answer: RuleAnswerSchema
  })
  .strict()

const NAMED_TEXT_ANCHORS = ['antigravity-text-composer'] as const
const NAMED_TITLE_PREDICATES = ['opencode-native-title'] as const

const AGENT_BLOCKED_REASONS = [
  'agent-update-prompt',
  'agent-trust-workspace',
  'agent-cwd-prompt',
  'agent-hooks-review-prompt',
  'agent-interactive-prompt',
  'agent-approval-prompt'
] as const satisfies readonly RuntimeTerminalWaitBlockedReason[]

/**
 * A position in the lowercased text tail. Text anchors read every pane whatever agent it runs (a
 * tail can show another agent's dialog, and an adopted pane has no known agent), and the latest one
 * in the text wins. A blocked anchor reads the blocked layer's live window. An idle or live one is
 * a live prompt, which cancels an earlier blocker; only an idle one settles a wait. A hold anchor,
 * found anywhere, stops every text anchor from settling one (the agent is up, not ready).
 */
const TextAnchorConditionSchema = z
  .object({
    region: z.literal('text'),
    /** Where the anchor starts: a literal's last occurrence, or a named engine scan. */
    find: z.union([
      z.object({ lastOf: TailLiteral }).strict(),
      z.object({ predicate: z.enum(NAMED_TEXT_ANCHORS) }).strict()
    ]),
    /** Reads only the last N lines of its input. */
    withinLastLines: z.number().int().min(1).max(64).optional(),
    /** The text from the anchor to the end must pass this. */
    after: TailTextTestSchema.optional(),
    /** Over the lines read, trailing blanks dropped: at least `atLeast` pass, the last one too
     *  when `includingLast`. */
    lines: z
      .object({
        atLeast: z.number().int().min(1).max(MAX_ROWS),
        includingLast: z.boolean(),
        test: TailTextTestSchema
      })
      .strict()
      .optional()
  })
  .strict()

/**
 * A title the shared classifier already calls idle, marked as an agent's own rest title. Like a
 * text anchor it is read whatever agent the pane runs: an adopted pane has no known agent, and a
 * pane can run another agent than it launched. `match` is a test, or a named engine predicate
 * shared with other title readers.
 */
const TitleAnchorConditionSchema = z
  .object({
    region: z.literal('title'),
    match: z.union([
      TextTestSchema,
      z.object({ predicate: z.enum(NAMED_TITLE_PREDICATES) }).strict()
    ])
  })
  .strict()

const AnchorSchema = z
  .object({
    id: Literal,
    why: Why,
    when: z.discriminatedUnion('region', [TextAnchorConditionSchema, TitleAnchorConditionSchema]),
    answer: z.discriminatedUnion('state', [
      z.object({ state: z.literal('blocked'), reason: z.enum(AGENT_BLOCKED_REASONS) }).strict(),
      z.object({ state: z.literal('idle') }).strict(),
      z.object({ state: z.literal('live') }).strict(),
      z.object({ state: z.literal('hold') }).strict()
    ])
  })
  .strict()
  .refine(
    (anchor) =>
      anchor.answer.state !== 'blocked' ||
      (anchor.when.region === 'text' && 'lastOf' in anchor.when.find),
    "a blocked anchor needs find.lastOf: the blocked layer's prefilter keys on it"
  )
  .refine(
    (anchor) => anchor.when.region !== 'title' || anchor.answer.state === 'idle',
    'a title anchor answers idle'
  )

/**
 * How far readiness may trust the agent's hooks. `authoritative`: they report every way the main
 * agent's turn ends (done, cancelled, an approval granted or denied), so a fresh hook row decides
 * ahead of the rules. `turn-end`: a hook `done` is always a real turn end, but some ends may send
 * nothing (Codex before its `Interrupt` hook), so only a `done` decides and a `working` or
 * permission row leaves the rules to decide. `identity-only` (the default): hooks only name the
 * agent and the rules decide (Claude sends no event when an approval is denied or Esc stops a tool).
 */
const HOOK_AUTHORITIES = ['authoritative', 'turn-end', 'identity-only'] as const

/** Facts about the agent that are not detection rules. */
const ProfileSchema = z
  .object({
    hooks: z.enum(HOOK_AUTHORITIES).optional(),
    /** Text whose presence in a pane's tail makes a tui-idle wait read its visible screen once. */
    screenProbeBanner: TailLiteral.optional(),
    /** The screen the rules read: the PTY's own grid, trusted only while the PTY still has that
     *  size, or the live emulator's. Rules keep the source they were recorded against. */
    screenSource: z.enum(['trusted', 'live']).optional()
  })
  .strict()

/** The panes no agent file covers: no launch record, and no recognised foreground process. */
export const UNKNOWN_PANE_RULES_ID = 'unknown-pane'

function hasUniqueIds(entries: readonly { id: string }[]): boolean {
  return new Set(entries.map((entry) => entry.id)).size === entries.length
}

export const AgentStateRulesFileSchema = z
  .object({
    id: z.union([
      z.literal(UNKNOWN_PANE_RULES_ID),
      z.custom<TuiAgent>(isTuiAgent, 'not a known agent')
    ]),
    engineVersion: z.literal(AGENT_STATE_RULES_ENGINE_VERSION),
    profile: ProfileSchema.optional(),
    anchors: z.array(AnchorSchema).max(MAX_RULES),
    rules: z.array(AgentStateRuleSchema).max(MAX_RULES)
  })
  .strict()
  .refine(
    (file) =>
      !file.rules.some((rule) => rule.when.region === 'screen') ||
      file.profile?.screenSource !== undefined,
    'a file with screen rules names its profile.screenSource'
  )
  .refine((file) => {
    const idleTextAnchors = new Set(
      file.anchors
        .filter((anchor) => anchor.when.region === 'text' && anchor.answer.state === 'idle')
        .map((anchor) => anchor.id)
    )
    return file.rules.every(
      (rule) => rule.when.region !== 'text' || idleTextAnchors.has(rule.when.anchor)
    )
  }, "a text rule names one of this file's idle text anchors")
  .refine(
    (file) => hasUniqueIds(file.anchors) && hasUniqueIds(file.rules),
    'anchor ids, and rule ids, are unique within the file'
  )

export type TextTest = z.infer<typeof TextTestSchema>
export type ScreenCondition = z.infer<typeof ScreenConditionSchema>
export type AgentStateRuleCondition = z.infer<typeof RuleConditionSchema>
export type AgentStateRuleAnswer = z.infer<typeof RuleAnswerSchema>
export type Anchor = z.infer<typeof AnchorSchema>
export type TextAnchorCondition = z.infer<typeof TextAnchorConditionSchema>
export type TitleAnchorCondition = z.infer<typeof TitleAnchorConditionSchema>
export type NamedTextAnchor = (typeof NAMED_TEXT_ANCHORS)[number]
export type NamedScreenPredicate = (typeof NAMED_SCREEN_PREDICATES)[number]
export type NamedTitlePredicate = (typeof NAMED_TITLE_PREDICATES)[number]
export type HookAuthority = (typeof HOOK_AUTHORITIES)[number]
export type AgentStateRulesFile = z.infer<typeof AgentStateRulesFileSchema>
