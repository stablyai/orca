import type { Prompt } from 'ssh2'
import type { SshConnectionCallbacks } from './ssh-connection-utils'

// Why: servers commonly reuse keyboard-interactive (RFC 4256) to collect the
// login password itself before issuing MFA challenges. Password-looking
// prompts route through the password credential flow (and its cache) so
// reconnects stay silent; every other prompt needs a fresh human answer.
const PASSWORD_PROMPT = /password/i
// Why: a one-time code answered with the cached login password would burn MFA
// attempts (and can lock the account) on every reconnect.
const ONE_TIME_PROMPT = /one.?time|otp/i
// Why: bounds a malicious/misbehaving server's prompt text before it reaches the credential dialog.
const PROMPT_DETAIL_MAX = 4_096

export function isKeyboardInteractivePasswordPrompt(prompt: Prompt): boolean {
  return (
    prompt.echo !== true &&
    PASSWORD_PROMPT.test(prompt.prompt) &&
    !ONE_TIME_PROMPT.test(prompt.prompt)
  )
}

export function formatKeyboardInteractivePromptDetail(
  instructions: string,
  promptText: string
): string {
  const trimmedInstructions = instructions.trim()
  const trimmedPrompt = promptText.trim()
  const detail =
    !trimmedInstructions || !trimmedPrompt
      ? trimmedInstructions || trimmedPrompt
      : `${trimmedInstructions}\n${trimmedPrompt}`
  return detail.slice(0, PROMPT_DETAIL_MAX)
}

export type KeyboardInteractiveSession = {
  targetId: string
  hostDetail: string
  requestCredential: SshConnectionCallbacks['onCredentialRequest']
  getCachedPassword: () => string | null
  setCachedPassword: (value: string) => void
  markCancelled: () => void
  isCancelled: () => boolean
  // Why: one cached-password auto-answer per connection attempt — a second
  // password prompt in the same attempt means the server rejected the cached
  // value, so the user must be asked again instead of looping a bad password.
  state: { passwordAutoAnswered: boolean }
}

// Answers one keyboard-interactive round. Returns null when the user
// cancelled (or no prompter is available); callers respond with no answers so
// the server fails the round and the regular auth-error flow takes over.
export async function collectKeyboardInteractiveResponses(
  session: KeyboardInteractiveSession,
  instructions: string,
  prompts: Prompt[],
  onPromptStart?: () => void
): Promise<string[] | null> {
  if (session.isCancelled()) {
    return null
  }
  // Why: a missing prompter is a capability gap, not a user decision — it
  // must return null WITHOUT calling markCancelled(), or SshConnection would
  // treat it as an explicit decline and skip its passphrase/password rungs.
  if (!session.requestCredential) {
    return null
  }
  const responses: string[] = []
  for (const prompt of prompts) {
    onPromptStart?.()
    const value = isKeyboardInteractivePasswordPrompt(prompt)
      ? await answerPasswordPrompt(session)
      : await session.requestCredential(
          session.targetId,
          'keyboard-interactive',
          formatKeyboardInteractivePromptDetail(instructions, prompt.prompt),
          prompt.echo
        )
    if (value == null) {
      session.markCancelled()
      return null
    }
    responses.push(value)
  }
  return responses
}

async function answerPasswordPrompt(
  session: KeyboardInteractiveSession
): Promise<string | null | undefined> {
  const cached = session.getCachedPassword()
  if (cached != null && !session.state.passwordAutoAnswered) {
    session.state.passwordAutoAnswered = true
    return cached
  }
  const value = await session.requestCredential?.(session.targetId, 'password', session.hostDetail)
  if (value == null) {
    return value
  }
  session.state.passwordAutoAnswered = true
  if (value) {
    session.setCachedPassword(value)
  }
  return value
}
