/**
 * Classifies one credential form from field descriptors, after Chromium's local password-form
 * parser (form_data_parser.cc, BSD; behaviour only, written here in TypeScript). Pure: no DOM.
 */
import type {
  BrowserPasswordFieldRole,
  BrowserPasswordFormKind
} from '../shared/browser-passwords-types'
import {
  autocompleteRoleToken,
  isCandidatePasswordFormField,
  isNewsletterForm,
  isPasswordLikeField,
  isSearchField,
  matchesUsernameWords,
  mentionsUsernameStep,
  type PasswordFieldDescriptor
} from './browser-password-field-rules'

export type PasswordFormDescriptor<F extends PasswordFieldDescriptor> = {
  /** Every `<input>` of the form, in document order. */
  fields: readonly F[]
  /** Lowercase text of the form; for a formless group, the text of its buttons only. */
  text: string
}

export type ParsedPasswordForm<F extends PasswordFieldDescriptor> = {
  kind: BrowserPasswordFormKind
  username: F | null
  password: F | null
  newPassword: F | null
  confirmPassword: F | null
}

type PasswordRoles<F> = { password: F | null; newPassword: F | null; confirmPassword: F | null }

function rolesFromAutocomplete<F extends PasswordFieldDescriptor>(
  passwords: readonly F[]
): PasswordRoles<F> | null {
  const current = passwords.find(
    (field) => autocompleteRoleToken(field.autocomplete) === 'current-password'
  )
  const fresh = passwords.filter(
    (field) => autocompleteRoleToken(field.autocomplete) === 'new-password'
  )
  if (!current && fresh.length === 0) {
    return null
  }
  // Why exclusive: Chromium trusts the page's own hints over value heuristics once it gives any.
  return {
    password: current ?? null,
    newPassword: fresh[0] ?? null,
    confirmPassword: fresh[1] ?? null
  }
}

function rolesFromCount<F extends PasswordFieldDescriptor>(
  passwords: readonly F[]
): PasswordRoles<F> {
  const visible = passwords.filter((field) => field.visible)
  const [first, second, third] = visible.length > 0 ? visible : passwords
  const none = { password: null, newPassword: null, confirmPassword: null }
  if (!first) {
    return none
  }
  if (!second) {
    return { ...none, password: first }
  }
  if (!third) {
    // Why both-empty is a change form: with nothing typed yet, equality says nothing.
    return first.value !== '' && first.value === second.value
      ? { ...none, newPassword: first, confirmPassword: second }
      : { ...none, password: first, newPassword: second }
  }
  const allEmpty = first.value === '' && second.value === '' && third.value === ''
  if (!allEmpty && first.value === second.value && first.value === third.value) {
    return { ...none, password: first }
  }
  // Why all-empty lands here: three empty password boxes are the current/new/confirm layout.
  if (second.value === third.value) {
    return { password: first, newPassword: second, confirmPassword: third }
  }
  if (first.value === second.value) {
    return { ...none, newPassword: first, confirmPassword: second }
  }
  return { ...none, password: first }
}

function lastOf<F>(fields: readonly F[]): F | null {
  return fields.at(-1) ?? null
}

function findUsernameBeforePasswords<F extends PasswordFieldDescriptor>(
  candidates: readonly F[],
  firstPassword: F
): F | null {
  const before = candidates
    .slice(0, candidates.indexOf(firstPassword))
    .filter((field) => !isPasswordLikeField(field) && !isSearchField(field))
  const focusable = before.filter((field) => field.visible)
  const pool = focusable.length > 0 ? focusable : before
  return lastOf(pool.filter(matchesUsernameWords)) ?? lastOf(pool)
}

function findUsernameOnlyField<F extends PasswordFieldDescriptor>(
  form: PasswordFormDescriptor<F>,
  textFields: readonly F[]
): F | null {
  if (isNewsletterForm(form.text, form.fields)) {
    return null
  }
  const visible = textFields.filter((field) => field.visible)
  const byAutocomplete = textFields.find((field) => {
    const role = autocompleteRoleToken(field.autocomplete)
    // Why email needs to stand alone: contact forms mark their email field the same way.
    return role === 'username' || (role === 'email' && visible.length === 1 && visible[0] === field)
  })
  if (byAutocomplete) {
    return byAutocomplete
  }
  const only = visible.length === 1 ? visible[0] : undefined
  return only && mentionsUsernameStep(form.text) ? only : null
}

function kindOf(roles: PasswordRoles<unknown>): BrowserPasswordFormKind {
  if (roles.password && roles.newPassword) {
    return 'change'
  }
  return roles.newPassword ? 'signup' : 'login'
}

/** Null when the form is not a credential form. */
export function parsePasswordForm<F extends PasswordFieldDescriptor>(
  form: PasswordFormDescriptor<F>
): ParsedPasswordForm<F> | null {
  const candidates = form.fields.filter(isCandidatePasswordFormField)
  const passwords = candidates.filter(isPasswordLikeField)
  const textFields = candidates.filter(
    (field) => !isPasswordLikeField(field) && !isSearchField(field)
  )
  const autocompleteUsername =
    textFields.find((field) => autocompleteRoleToken(field.autocomplete) === 'username') ?? null

  if (passwords.length === 0) {
    const username = findUsernameOnlyField(form, textFields)
    return username
      ? {
          kind: 'username-only',
          username,
          password: null,
          newPassword: null,
          confirmPassword: null
        }
      : null
  }

  const roles = rolesFromAutocomplete(passwords) ?? rolesFromCount(passwords)
  const firstRoled = [roles.password, roles.newPassword, roles.confirmPassword]
    .filter((field): field is F => field !== null)
    .sort((a, b) => candidates.indexOf(a) - candidates.indexOf(b))[0]
  if (!firstRoled) {
    return null
  }
  const username = autocompleteUsername ?? findUsernameBeforePasswords(candidates, firstRoled)
  return { kind: kindOf(roles), username, ...roles }
}

export function passwordFieldRoleIn<F extends PasswordFieldDescriptor>(
  parsed: ParsedPasswordForm<F>,
  field: F
): BrowserPasswordFieldRole | null {
  if (field === parsed.username) {
    return 'username'
  }
  if (field === parsed.password) {
    return 'password'
  }
  return field === parsed.newPassword || field === parsed.confirmPassword ? 'new-password' : null
}
