import { PROVIDER_PATTERNS } from '../observability/redactor'

// Why not `redactString`: its labeled-kv and .env-line rules are tuned for
// stack traces and are far too eager over transcript text — every pasted
// `MAX_RETRIES = 3` diff line would lose its value, and prose like
// `token: the next token` would lose the word `token` itself, taking the
// searchable content with it. The provider fingerprints are shape-matched and
// safe over prose, so those are reused verbatim, plus the one shape they miss:
// an opaque (non-JWT) bearer token.
const BEARER_TOKEN = /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{16,}/g

// One scan decides whether the eight fingerprint passes run at all: every
// pattern above is anchored on one of these, so text without them cannot match.
const SECRET_ANCHOR = /sk-|gh[pousr]_|AKIA|eyJ|xox|-----|[Bb]earer|aws_secret_access_key/

/** Strips credential-shaped spans so the index (and every snippet) never holds one. */
export function redactSessionSearchText(text: string): string {
  if (!SECRET_ANCHOR.test(text)) {
    return text
  }
  let out = text
  for (const { tag, re } of PROVIDER_PATTERNS) {
    out = out.replace(re, `[redacted:${tag}]`)
  }
  return out.replace(BEARER_TOKEN, '$1 [redacted:bearer-token]')
}
