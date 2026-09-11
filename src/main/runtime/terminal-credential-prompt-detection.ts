import { startOfLastNonBlankLines } from './terminal-wait-tail-window'

/**
 * Recognizes a live credential / authentication prompt owning the bottom of a
 * terminal screen.
 *
 * Why this exists separately from the agent-specific blocked signals: every
 * readiness detector Orca has can be wrong, and when one is, the caller types
 * the user's task prompt into whatever surface is actually on screen. If that
 * surface is a credential prompt the prompt is submitted to an auth provider as
 * a credential attempt, and — because the daemon records raw PTY output
 * unredacted — an echoing prompt also writes it into the session transcript. So
 * this is deliberately agent-agnostic: it keys on the shape of a credential
 * prompt, not on which agent drew it.
 *
 * The bias is asymmetric on purpose. A false negative types secrets-adjacent
 * text into a credential field; a false positive only delays a prompt until the
 * dialog is answered, and the wait poll re-evaluates the tail continuously, so
 * a refusal clears on its own.
 *
 * That asymmetry is not a licence to match auth wording anywhere in the window:
 * the refusal is unconditional, so a false positive also pins an idle agent to
 * `permission` in the agent-status store. Every rule here therefore demands
 * prompt *shape* — a terminator, or the bottom row of the screen — because an
 * agent narrating auth work reads as prose and leaves its own composer caret on
 * the last row.
 */

// Why bounded: an answered credential prompt stays in scrollback, and agents
// print credential wording constantly while working on auth code. Only a prompt
// owning the screen bottom is live.
const CREDENTIAL_TAIL_LINES = 4

// Why capped: a wrapped narration line is not a prompt, and an unbounded line
// makes the per-line scan the hot path for streaming output.
const MAX_CREDENTIAL_LINE_LENGTH = 512

// Why `_` is a separator too: the most common api-key ask names the env var it fills
// ("Enter your OPENAI_API_KEY:"), and `api key` alone misses every one of them. The vendor
// segment before it is handled by the prefix rules, not here — a variable-length prefix inside
// a noun alternation makes this whole pattern quadratic on long lines, and it runs per retained
// tail line at streaming rate.
const CREDENTIAL_NOUN_SOURCE =
  'password|passphrase|api[ _-]?keys?|access[ _-]tokens?|auth(?:orization)?[ _-]tokens?|bearer tokens?|personal access tokens?|secret keys?|client secrets?|one[- ]time (?:code|password)|otp|verification codes?|authentication codes?|security codes?|2fa codes?|device codes?|credentials?'

const CREDENTIAL_NOUN_RE = new RegExp(CREDENTIAL_NOUN_SOURCE, 'gi')
const CREDENTIAL_NOUN_ANYWHERE_RE = new RegExp(CREDENTIAL_NOUN_SOURCE, 'i')

// Why a vendor slot: real prompts read "enter your Anthropic API key" and
// "paste your personal access token", not just "enter your API key".
//
// Why anchored: unanchored, the ask verb could sit anywhere, so any prose that happened to end on
// a credential noun read as a prompt — `// Why: a merely missing or expired bundle must not enter
// the credential` is a real wrapped comment in this repo, and terminal wrapping makes ending on a
// noun routine. A dialog addresses the user, so its ask verb leads the row, modulo decoration and
// a menu number (`2. Paste an API key`).
const CREDENTIAL_ASK_PREFIX_RE =
  /^[^a-z0-9]{0,8}(?:\d{1,2}[.)]\s*)?(?:please\s+)?(?:enter|re-?enter|type|paste|input|provide|confirm)(?:\s+(?:your|the|a|an|my|new|current|old))?(?:\s+[a-z][a-z0-9.'-]{0,20}){0,2}[\s_]+$/i

// A bare label prompt: decoration, an optional qualifier, an optional env-var vendor segment
// (`ANTHROPIC_API_KEY:`), then the noun.
const CREDENTIAL_LABEL_PREFIX_RE =
  /^[^a-z0-9]{0,8}(?:(?:new|current|old|your)\s+)?(?:[a-z][a-z0-9]{0,20}_)?$/i

const PURE_TERMINATOR_RE = /^[\s:?>›❯»*_|.…-]{0,16}$/
const FOR_TARGET_TERMINATED_RE = /[:?>›❯»_]\s*$/
const FOR_TARGET_RE = /^\s+(?:for|to)\s/i

// Why `?` is excluded here: a credential prompt ends in a colon or an input
// caret. An agent legitimately asking the user a credential-adjacent question
// ("Should I store the password in .env?") ends in a question mark, and that
// must not read as a prompt.
const CLAUSE_TERMINATED_RE = /[:›❯»>_]\s*$/

// Why the whole wording after `[sudo]` is unconstrained: sudo translates its prompt
// ("[sudo] Passwort für neil:", "[sudo] neil 的密碼："), but never the `[sudo]` tag, and the
// only thing sudo ever asks for at that tag is a password.
const SUDO_PASSWORD_RE = /^[^a-z0-9]{0,8}\[sudo\]\s/i
const GIT_CREDENTIAL_RE = /^[^a-z0-9]{0,8}(?:username|password) for ['"]?[a-z][a-z0-9+.-]*:\/\//i

// Why the lookbehind: `user.login`, `candidate.login` and `overrides.filter((login) =>` are
// property accesses, not auth wording, and `\b` treats `.` as a boundary. Agents print this
// repo's own source constantly.
const AUTH_VERB_RE =
  /(?<![.\w])(?:sign[ -]?in|signin|log[ -]?in|authenticate|authorized?|authorization|authentication)\b/i

// Wording only a dialog addressing the user uses.
// Why `waiting for you to` carries an auth continuation: bare "waiting for you to …" is how
// every agent narrates waiting on a review, a branch choice or an approval.
const AUTH_ACTION_FLOW_SOURCE =
  'sign[ -]?in with|log[ -]?in with|authenticate with|authentication required|authorization required|sign[ -]?in required|login required|enter (?:the )?code|waiting for (?:authentication|authorization|you to (?:sign|log|authenticate|authoriz|finish|enter (?:the |your )?code))|open (?:this|the following) url|press enter to (?:open|sign)|paste (?:it|(?:the |your )?code) (?:here|below)'
// Wording equally at home in a dialog and in narration about auth work.
const AUTH_TOPIC_FLOW_SOURCE =
  'device code|verification code|two[ -]factor|2fa|authenticator app|mfa|\\d-digit code'

const AUTH_FLOW_RE = new RegExp(
  `\\b(?:${AUTH_ACTION_FLOW_SOURCE}|${AUTH_TOPIC_FLOW_SOURCE})\\b`,
  'i'
)

/**
 * An action phrase the row *opens* with, modulo dialog decoration and the few lead-ins a
 * dialog uses ("and enter the code:", "Please sign in with…").
 *
 * Why position matters: a dialog addresses the user, so its action phrase leads the row. The
 * same phrase buried behind other words is a *mention* of auth work — a commit subject
 * (`d4e5f6a feat(auth): sign in with GitHub`), a changelog bullet, a checklist item, an error
 * summary (`• Root cause: authentication required from the vercel CLI`). Those are the shape a
 * false positive takes, and the reason is unconditional, so they must not read as a prompt.
 */
const AUTH_ACTION_FLOW_LEADS_ROW_RE = new RegExp(
  `^[^a-z0-9]{0,8}(?:(?:and|then|now|please|first|next|finally|you (?:must|need to|can))\\s+){0,2}(?:${AUTH_ACTION_FLOW_SOURCE})\\b`,
  'i'
)

// An inquirer-style question row. Prose never starts with a bare `?` — but FORMATTED CODE does:
// oxfmt puts a ternary's consequent on its own row as `? someValue`, and 5,666 tracked files in
// this repo have one. So the row rule alone is not enough; see `COMPOSER_CARET_ROW_RE`.
const AUTH_QUESTION_ROW_RE = /^\?\s+\S/

/**
 * A row that proves the agent is sitting at its own composer, so nothing is asking the user
 * anything and a `?` row above it is output, not a dialog header.
 *
 * Why a bare `>` is safe to include here: this suppresses only the question-row rule, which is
 * the one rule with no position requirement. A sign-in dialog drawn OVER ready chrome — the
 * #19749 shape, whose own bottom row is `>` — matches through `isCredentialPromptLine` instead,
 * and that returns before this is consulted.
 */
const COMPOSER_CARET_ROW_RE = /^(?:›\s*ask\b.*|✳\s*claude code\b.*|[>❯›◇»$])$/i

// A finished sentence, i.e. narration. A lone `.`/`!`/`?` ends a clause; `...`
// and `…` are progress wording ("opening browser...") and are not sentences.
// Why CJK punctuation counts: an agent narrating auth work in Chinese or Japanese writes
// `。`/`，` and never an ASCII period, so the English-only test leaves localized narration
// with no way to read as prose — and the wording it embeds is still English.
const NARRATION_ROW_RE = /(?:^|[^.])\.(?:\s|$)|[!?]\s*$|[。！？，、；]/

/**
 * Cheap superset of everything `findCredentialPromptIndex` can match, tested
 * per retained tail line at streaming rate. Must stay a superset: a tail the
 * index rejects is never parsed in full.
 */
export const TERMINAL_CREDENTIAL_PROMPT_SENTINEL_RE = new RegExp(
  // Why the box-glyph run after the terminator: `findCredentialPromptIndex` blanks box rules
  // before it reads a row, so a dialog drawn in a frame ends `… API key here:   │`. Without this
  // the sentinel rejects the tail and the prompt is never parsed at all.
  `(?:(?:${CREDENTIAL_NOUN_SOURCE}|username for)[^\\n]{0,64}[:?>›❯»_][\\s\\u2500-\\u257f]*$)|` +
    // Why a bare row-final noun counts: `PURE_TERMINATOR_RE` treats end-of-row as a terminator,
    // so a menu option (`2. Paste an API key`) is a prompt to the index with no punctuation at
    // all. Without this the main lane's prefilter drops the Antigravity sign-in menu that this
    // whole guard was written for, while the renderer lane — which has no prefilter — refuses it.
    `(?:(?:${CREDENTIAL_NOUN_SOURCE})[\\s\\u2500-\\u257f]*$)|` +
    // Why literal: sudo's prompt is translated, so only the untranslated tag survives.
    `(?:\\[sudo\\]\\s)|` +
    `(?:${AUTH_FLOW_RE.source})|` +
    `(?:^\\s*\\?\\s+[^\\n]{0,120}(?:${AUTH_VERB_RE.source}))`,
  'im'
)

/**
 * Whether `line` is itself a credential prompt. `isLastRow` gates the bare-label
 * form (`password:`) because a label with no ask verb is also how printed k8s
 * manifests and form templates read; only the screen's bottom row is a prompt.
 */
function isCredentialPromptLine(line: string, isLastRow: boolean): boolean {
  if (line.length > MAX_CREDENTIAL_LINE_LENGTH) {
    return false
  }
  if (SUDO_PASSWORD_RE.test(line) || GIT_CREDENTIAL_RE.test(line)) {
    return true
  }
  CREDENTIAL_NOUN_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = CREDENTIAL_NOUN_RE.exec(line)) !== null) {
    const prefix = line.slice(0, match.index)
    const suffix = line.slice(match.index + match[0].length)
    const terminated =
      PURE_TERMINATOR_RE.test(suffix) ||
      (suffix.length <= 100 &&
        FOR_TARGET_RE.test(suffix) &&
        FOR_TARGET_TERMINATED_RE.test(suffix)) ||
      (suffix.length <= 64 && CLAUSE_TERMINATED_RE.test(suffix))
    if (!terminated) {
      continue
    }
    if (CREDENTIAL_ASK_PREFIX_RE.test(prefix)) {
      return true
    }
    if (isLastRow && CREDENTIAL_LABEL_PREFIX_RE.test(prefix)) {
      return true
    }
  }
  return false
}

/** Offset of the live credential prompt in `normalized`, or null. */
export function findCredentialPromptIndex(normalized: string): number | null {
  const windowStart = startOfLastNonBlankLines(normalized, CREDENTIAL_TAIL_LINES)
  const tail = normalized.slice(windowStart)
  const raws = tail.split('\n')
  // Why: dialogs are drawn inside box rules, which otherwise glue the frame to the wording.
  const lines = raws.map((raw) => raw.replace(/[\u2500-\u257f]+/g, ' ').trim())
  const lastRow = lines.findLastIndex((line) => line.length > 0)

  let offset = 0
  let promptIndex: number | null = null
  let sawAuthVerb = false
  let sawCredentialNoun = false
  let sawAuthQuestion = false
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (isCredentialPromptLine(line, index === lastRow)) {
      promptIndex = windowStart + offset
    }
    if (line.length <= MAX_CREDENTIAL_LINE_LENGTH) {
      sawAuthVerb = sawAuthVerb || AUTH_VERB_RE.test(line)
      sawCredentialNoun = sawCredentialNoun || CREDENTIAL_NOUN_ANYWHERE_RE.test(line)
      sawAuthQuestion =
        sawAuthQuestion ||
        (AUTH_QUESTION_ROW_RE.test(line) && (AUTH_VERB_RE.test(line) || AUTH_FLOW_RE.test(line)))
    }
    offset += raws[index].length + 1
  }
  if (promptIndex !== null) {
    return promptIndex
  }
  // A flow marker alone is narration ("added the 2fa tests"). It is a live auth
  // surface only when it owns the bottom row as an unfinished request, or when
  // an interactive auth question drew the screen.
  const bottomRow = lastRow === -1 ? '' : lines[lastRow]
  const bottomRowAsks =
    AUTH_ACTION_FLOW_LEADS_ROW_RE.test(bottomRow) ||
    (AUTH_FLOW_RE.test(bottomRow) && CLAUSE_TERMINATED_RE.test(bottomRow))
  const authFlowOwnsBottom =
    bottomRow.length <= MAX_CREDENTIAL_LINE_LENGTH &&
    bottomRowAsks &&
    !NARRATION_ROW_RE.test(bottomRow) &&
    (sawAuthVerb || sawCredentialNoun)
  const bottomRowIsComposerCaret = COMPOSER_CARET_ROW_RE.test(bottomRow)
  return authFlowOwnsBottom || (sawAuthQuestion && !bottomRowIsComposerCaret) ? windowStart : null
}
