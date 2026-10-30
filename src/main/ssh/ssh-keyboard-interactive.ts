import type { Prompt } from 'ssh2'
import type { SshConnectionCallbacks } from './connection/ssh-connection-callbacks'

// Route password challenges through cached-password auth; other MFA prompts require fresh human answers.
const PASSWORD_PROMPT = /password/i
// Never auto-answer OTP with cached password: repeated reconnects can exhaust MFA attempts or lock accounts.
const ONE_TIME_PROMPT = /one.?time|otp/i
// Bound host-controlled prompt text before showing credential UI.
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
  markCachedPasswordRejected: () => void
  markCancelled: () => void
  isCancelled: () => boolean
  // Auto-answer cached password once per attempt; repeated challenge proves refusal and must prompt again.
  state: { passwordAutoAnswered: boolean }
}

// Null means no usable answers; send none so normal authentication failure handling resumes.
export async function collectKeyboardInteractiveResponses(
  session: KeyboardInteractiveSession,
  instructions: string,
  prompts: Prompt[],
  onPromptStart?: () => void
): Promise<string[] | null> {
  if (session.isCancelled()) {
    return null
  }
  // Missing prompter is no user decline; do not suppress remaining passphrase/password rungs.
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
    if (session.isCancelled()) {
      return null
    }
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
  if (cached != null) {
    session.markCachedPasswordRejected()
  }
  const value = await session.requestCredential?.(session.targetId, 'password', session.hostDetail)
  if (session.isCancelled()) {
    return null
  }
  if (value == null) {
    return value
  }
  session.state.passwordAutoAnswered = true
  if (value) {
    session.setCachedPassword(value)
  }
  return value
}
