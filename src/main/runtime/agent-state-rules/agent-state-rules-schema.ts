import { z } from 'zod'
import type { RuntimeTerminalWaitBlockedReason } from '../../../shared/runtime-types'
import type { TuiAgent } from '../../../shared/tui-agent'
import { isTuiAgent } from '../../../shared/tui-agent-config'
import { findUnsafePatternReason } from './agent-state-rule-pattern-safety'

/** Shipped engine versions must bump when regions, predicates or answers expand. */
export const AGENT_STATE_RULES_ENGINE_VERSION = 1

const MAX_PATTERN_LENGTH = 200
const MAX_RULES = 32
const MAX_ROWS = 12
const MAX_TERMS = 8

const Literal = z.string().min(1).max(MAX_PATTERN_LENGTH)

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

// JSON carries rule rationale as data.
const Why = z.string().min(1).max(600)

const NAMED_SCREEN_PREDICATES = ['codex-header-ready', 'codex-composer-ready'] as const

/** Rows match consecutive trimmed lines, ending at the bottom-most match within endsWithinBottom.
 * Offscreen rows read empty; named predicates scan lowercased screens; no condition means readable. */
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

const TitleConditionSchema = z
  .object({ region: z.literal('title'), status: z.enum(['idle']) })
  .strict()

/** An idle text anchor settles only without a later blocker or any hold anchor. */
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
      /** Clockless panes accept strong quiet rules immediately unless explicitly skipped. */
      withoutClock: z.literal('skip').optional()
    })
    .strict()
    .refine(
      (answer) => !answer.withoutClock || (answer.requiresQuiet && answer.strength === 'strong'),
      'withoutClock is for strong rules that require quiet'
    ),
  // A readable refusal must also block weak title/process readiness.
  z.object({ state: z.literal('hold') }).strict()
])

/** Highest priority first; ties retain file order. */
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

/** Anchors read all panes: launch identity may be absent or differ from the running agent.
 * Latest live/idle cancels earlier blockers; only idle settles. Blockers use the live window; any hold prevents settling. */
const TextAnchorConditionSchema = z
  .object({
    region: z.literal('text'),
    /** Where the anchor starts: a literal's last occurrence, or a named engine scan. */
    find: z.union([
      z.object({ lastOf: TailLiteral }).strict(),
      z.object({ predicate: z.enum(NAMED_TEXT_ANCHORS) }).strict()
    ]),
    withinLastLines: z.number().int().min(1).max(64).optional(),
    /** The text from the anchor to the end must pass this. */
    after: TailTextTestSchema.optional(),
    /** Ignore trailing blanks; includingLast also requires the final line to pass. */
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

/** Mark an idle-classified title as agent-owned, regardless of launch identity. */
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

/** Authoritative hooks cover all turn endings and outrank rules.
 * Turn-end trusts only done (older Codex interrupts and DSH approvals may emit nothing).
 * Identity-only (default) leaves readiness to rules: Claude denial/Esc may emit nothing. */
const HOOK_AUTHORITIES = ['authoritative', 'turn-end', 'identity-only'] as const

const ProfileSchema = z
  .object({
    hooks: z.enum(HOOK_AUTHORITIES).optional(),
    /** Text whose presence in a pane's tail makes a tui-idle wait read its visible screen once. */
    screenProbeBanner: TailLiteral.optional(),
    /** Preserve the recorded screen source; the PTY grid is trusted only at its current size. */
    screenSource: z.enum(['trusted', 'live']).optional()
  })
  .strict()

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
