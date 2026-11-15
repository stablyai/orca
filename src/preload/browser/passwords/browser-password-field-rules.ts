/**
 * Per-field rules for credential form classification, after Chromium's local password-form
 * parser (form_data_parser.cc, BSD) and Bitwarden's newsletter rule. Pure: no DOM access.
 */

/** What the classifier needs to know about one `<input>`, read once by the DOM layer. */
export type PasswordFieldDescriptor = {
  /** The input's `type` property, lowercased (absent or unknown types read as 'text'). */
  type: string
  /** True when the input has ever been `type=password`, so show-password toggles stay passwords. */
  wasPassword: boolean
  name: string
  id: string
  autocomplete: string
  placeholder: string
  ariaLabel: string
  labelText: string
  /** Typed or filled value; '' when the user has not typed into it. */
  value: string
  /** Rendered with a non-empty box, not display:none or visibility:hidden. */
  visible: boolean
  disabled: boolean
}

const TEXT_LIKE_TYPES = new Set(['text', 'email', 'number', 'search', 'tel', 'url'])
const OTP_PATTERN =
  /one.?time|\b(otp|otc|totp|sms|2fa|mfa)\b|verif(y|ication)?.?code|two.?factor|2.?factor|security.?code/i
const SSN_PATTERN = /ssn|social.?security/i
const CVC_PATTERN = /cvc|cvv|csc|card.?(verification|security)/i
const USERNAME_WORDS_PATTERN = /user.?name|login|email|e-mail|account|userid|user.?id|identifier/i
const SEARCH_TOKENS = new Set(['search', 'query', 'find'])
const NEWSLETTER_PATTERN = /newsletter|subscri(be|ption)|mailing.?list/i
const USERNAME_STEP_PATTERN = /sign.?in|log.?in|continue|next/i
const USERNAME_PLACEHOLDER_VALUES = new Set(['email', 'username', 'username or email'])

/** The role-bearing token of an autocomplete attribute: its last token, ignoring `webauthn`. */
export function autocompleteRoleToken(autocomplete: string): string {
  const tokens = autocomplete.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.at(-1) === 'webauthn') {
    tokens.pop()
  }
  return tokens.at(-1) ?? ''
}

export function isPasswordLikeField(field: PasswordFieldDescriptor): boolean {
  return field.type === 'password' || field.wasPassword
}

/** The cheap first gate, so the DOM layer skips layout reads for checkboxes, hidden inputs and the like. */
export function isCredentialInputType(type: string, wasPassword: boolean): boolean {
  return type === 'password' || wasPassword || TEXT_LIKE_TYPES.has(type)
}

export function isCandidatePasswordFormField(field: PasswordFieldDescriptor): boolean {
  if (field.disabled || !isCredentialInputType(field.type, field.wasPassword)) {
    return false
  }
  const role = autocompleteRoleToken(field.autocomplete)
  if (role === 'one-time-code' || role.startsWith('cc-')) {
    return false
  }
  // Why word-split: `\b` alone misses `otp_code` and `otpCode`.
  const nameAndId = words(`${field.name} ${field.id}`).join(' ')
  return (
    !OTP_PATTERN.test(nameAndId) && !SSN_PATTERN.test(nameAndId) && !CVC_PATTERN.test(nameAndId)
  )
}

export function matchesUsernameWords(field: PasswordFieldDescriptor): boolean {
  return [field.name, field.id, field.labelText, field.placeholder, field.ariaLabel].some((text) =>
    USERNAME_WORDS_PATTERN.test(text)
  )
}

/** Splits `searchInput`, `site-search` and `q_find` alike into lowercase words. */
function words(text: string): string[] {
  return text
    .split(/[^A-Za-z0-9]+|(?<=[a-z])(?=[A-Z])/)
    .filter(Boolean)
    .map((word) => word.toLowerCase())
}

export function isSearchField(field: PasswordFieldDescriptor): boolean {
  if (field.type === 'search') {
    return true
  }
  return [field.name, field.id, field.placeholder].some((text) =>
    words(text).some((word) => SEARCH_TOKENS.has(word))
  )
}

export function isNewsletterForm(
  text: string,
  fields: readonly PasswordFieldDescriptor[]
): boolean {
  return (
    NEWSLETTER_PATTERN.test(text) ||
    fields.some((field) => NEWSLETTER_PATTERN.test(`${field.name} ${field.id}`))
  )
}

export function mentionsUsernameStep(text: string): boolean {
  return USERNAME_STEP_PATTERN.test(text)
}

/** True for a username field value a fill may overwrite: empty, or a page's stand-in text. */
export function isPlaceholderUsernameValue(value: string): boolean {
  const normalized = value.trim().toLowerCase()
  return (
    normalized === '' || USERNAME_PLACEHOLDER_VALUES.has(normalized) || normalized.startsWith('@')
  )
}
