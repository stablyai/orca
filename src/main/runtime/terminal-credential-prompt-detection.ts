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
 */

// Why bounded: an answered credential prompt stays in scrollback, and agents
// print credential wording constantly while working on auth code. Only a prompt
// owning the screen bottom is live.
const CREDENTIAL_TAIL_LINES = 4

// Why capped: a wrapped narration line is not a prompt, and an unbounded line
// makes the per-line scan the hot path for streaming output.
const MAX_CREDENTIAL_LINE_LENGTH = 512

const CREDENTIAL_NOUN_SOURCE =
  'password|passphrase|api[ -]?keys?|access[ -]tokens?|auth(?:orization)?[ -]tokens?|bearer tokens?|personal access tokens?|secret keys?|client secrets?|one[- ]time (?:code|password)|otp|verification codes?|authentication codes?|security codes?|2fa codes?|device codes?|credentials?'

const CREDENTIAL_NOUN_RE = new RegExp(CREDENTIAL_NOUN_SOURCE, 'gi')

// Why a vendor slot: real prompts read "enter your Anthropic API key" and
// "paste your personal access token", not just "enter your API key".
const CREDENTIAL_ASK_PREFIX_RE =
  /(?:^|[^a-z])(?:enter|re-?enter|type|paste|input|provide|confirm)(?:\s+(?:your|the|a|an|my|new|current|old))?(?:\s+[a-z][a-z0-9.'-]{0,20}){0,2}\s+$/i

// A bare label prompt: decoration, an optional qualifier, then the noun.
const CREDENTIAL_LABEL_PREFIX_RE = /^[^a-z0-9]{0,8}(?:(?:new|current|old|your)\s+)?$/i

const PURE_TERMINATOR_RE = /^[\s:?>›❯»*_|.…-]{0,16}$/
const FOR_TARGET_TERMINATED_RE = /[:?>›❯»_]\s*$/
const FOR_TARGET_RE = /^\s+(?:for|to)\s/i

// Why `?` is excluded here: a credential prompt ends in a colon or an input
// caret. An agent legitimately asking the user a credential-adjacent question
// ("Should I store the password in .env?") ends in a question mark, and that
// must not read as a prompt.
const CLAUSE_TERMINATED_RE = /[:›❯»>_]\s*$/

const SUDO_PASSWORD_RE = /^[^a-z0-9]{0,8}\[sudo\]\s+password for\b/i
const GIT_CREDENTIAL_RE = /^[^a-z0-9]{0,8}(?:username|password) for ['"]?[a-z][a-z0-9+.-]*:\/\//i

// Why two markers: a lone auth verb is narration. A device-code or sign-in
// dialog always pairs the verb with a flow marker in the same live window.
const AUTH_VERB_RE =
  /\b(?:sign[ -]?in|signin|log[ -]?in|authenticate|authorized?|authorization|authentication)\b/i
const AUTH_FLOW_RE =
  /\b(?:sign[ -]?in with|log[ -]?in with|authenticate with|authentication required|authorization required|sign[ -]?in required|login required|enter (?:the )?code|device code|verification code|waiting for (?:authentication|authorization|you to)|open (?:this|the following) url|press enter to (?:open|sign)|paste (?:it|the code) (?:here|below)|two[ -]factor|2fa|authenticator app|mfa|\d-digit code)\b/i

/**
 * Cheap superset of everything `findCredentialPromptIndex` can match, tested
 * per retained tail line at streaming rate. Must stay a superset: a tail the
 * index rejects is never parsed in full.
 */
export const TERMINAL_CREDENTIAL_PROMPT_SENTINEL_RE = new RegExp(
  `(?:(?:${CREDENTIAL_NOUN_SOURCE}|username for)[^\\n]{0,64}[:?>›❯»_]\\s*$)|` +
    `(?:${AUTH_FLOW_RE.source})`,
  'im'
)

function isCredentialPromptLine(line: string): boolean {
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
    if (CREDENTIAL_ASK_PREFIX_RE.test(prefix) || CREDENTIAL_LABEL_PREFIX_RE.test(prefix)) {
      return true
    }
  }
  return false
}

/** Offset of the live credential prompt in `normalized`, or null. */
export function findCredentialPromptIndex(normalized: string): number | null {
  const windowStart = startOfLastNonBlankLines(normalized, CREDENTIAL_TAIL_LINES)
  const tail = normalized.slice(windowStart)
  let offset = 0
  let promptIndex: number | null = null
  let sawAuthVerb = false
  let sawAuthFlow = false
  for (const raw of tail.split('\n')) {
    // Why: dialogs are drawn inside box rules, which otherwise glue the frame to the wording.
    const line = raw.replace(/[\u2500-\u257f]+/g, ' ').trim()
    if (isCredentialPromptLine(line)) {
      promptIndex = windowStart + offset
    }
    if (line.length <= MAX_CREDENTIAL_LINE_LENGTH) {
      sawAuthVerb = sawAuthVerb || AUTH_VERB_RE.test(line)
      sawAuthFlow = sawAuthFlow || AUTH_FLOW_RE.test(line)
    }
    offset += raw.length + 1
  }
  if (promptIndex !== null) {
    return promptIndex
  }
  return sawAuthVerb && sawAuthFlow ? windowStart : null
}
