// Why anchored messages rather than `isENOENT`: over SSH the relay replaces a string errno with
// -32000 and forwards only the message (`relay/dispatcher-rpc-routing.ts`,
// `ssh/ssh-channel-multiplexer.ts`), so the message is the ONLY classification path remotely.
// Anchoring at the start stops a path that merely quotes an errno from matching.
const ENOENT_MESSAGE = /^ENOENT: no such file or directory\b/
const ENOTDIR_MESSAGE = /^ENOTDIR: not a directory\b/

// Why shape rather than a fixed list: EVERY real errno is authoritative, not just the two we care
// about — an EACCES or ELOOP is a definitive non-absence answer even when the message quotes
// ENOENT. Underscores are required: `EAI_AGAIN`/`EAI_NONAME` are real libuv codes, and missing them
// let a transient DNS failure fall through to the message and read as proven absence.
//
// An E-prefixed code we do not recognise is therefore treated as an errno, i.e. NOT absence. That
// biases toward refusing, which is the safe direction for this helper. Only a code that is not
// errno-shaped at all (`REMOTE_FS_ERROR`, or the relay's numeric -32000) falls through to the
// message — the only classification path that survives the SSH relay.
const ERRNO_NAME = /^E[A-Z0-9_]+$/

/** Whether a failed probe proves the path is absent. Never throws. */
export function isProvenAbsent(error: unknown): boolean {
  const { code, failed } = readErrnoCode(error)
  // An unreadable errno is not evidence that the path is absent. Do not let a
  // canonical-looking message turn an error with a hostile shape into absence.
  if (failed) {
    return false
  }
  if (code !== undefined && ERRNO_NAME.test(code)) {
    return code === 'ENOENT'
  }
  return ENOENT_MESSAGE.test(readMessage(error))
}

/**
 * Whether the probe proved the parent is not a directory — a definite answer about the target,
 * not an indeterminate probe, so callers should say so rather than "could not check".
 */
export function isNotADirectory(error: unknown): boolean {
  const { code, failed } = readErrnoCode(error)
  if (failed) {
    return false
  }
  if (code !== undefined && ERRNO_NAME.test(code)) {
    return code === 'ENOTDIR'
  }
  return ENOTDIR_MESSAGE.test(readMessage(error))
}

// Why guarded: `?.` only protects a nullish base — it still invokes an accessor, so a throwing
// `code` getter would escape a fail-closed path as an unhandled rejection.
function readErrnoCode(error: unknown): { code: string | undefined; failed: boolean } {
  if (typeof error !== 'object' || error === null) {
    return { code: undefined, failed: false }
  }
  try {
    const code = (error as { code?: unknown }).code
    return { code: typeof code === 'string' ? code : undefined, failed: false }
  } catch {
    return { code: undefined, failed: true }
  }
}

function readMessage(error: unknown): string {
  if (typeof error !== 'object' || error === null) {
    return ''
  }
  try {
    const message = (error as { message?: unknown }).message
    return typeof message === 'string' ? message : ''
  } catch {
    return ''
  }
}

/** Safe message for user-facing errors — a hostile `message` getter must not escape a refusal. */
export function describeError(error: unknown): string {
  const message = readMessage(error)
  if (message !== '') {
    return message
  }
  // Why guarded too: `String(error)` calls toString(), which reads `message` again — the same trap
  // one level down.
  try {
    return String(error)
  } catch {
    return 'unknown error'
  }
}
