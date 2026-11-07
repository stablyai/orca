import { describe, expect, it } from 'vitest'
import type { PasswordFieldDescriptor } from './browser-password-field-rules'
import { isPlaceholderUsernameValue } from './browser-password-field-rules'
import { parsePasswordForm, passwordFieldRoleIn } from './browser-password-form-parser'

type TestField = PasswordFieldDescriptor & { key: string }

function input(key: string, overrides: Partial<PasswordFieldDescriptor> = {}): TestField {
  return {
    key,
    type: 'text',
    wasPassword: false,
    name: key,
    id: '',
    autocomplete: '',
    placeholder: '',
    ariaLabel: '',
    labelText: '',
    value: '',
    visible: true,
    disabled: false,
    ...overrides
  }
}

function password(key: string, overrides: Partial<PasswordFieldDescriptor> = {}): TestField {
  return input(key, { type: 'password', ...overrides })
}

type Expected = {
  kind: string
  username?: string | null
  password?: string | null
  newPassword?: string | null
  confirmPassword?: string | null
} | null

function parse(fields: TestField[], text = ''): Expected {
  const parsed = parsePasswordForm({ fields, text })
  if (!parsed) {
    return null
  }
  return {
    kind: parsed.kind,
    username: parsed.username?.key ?? null,
    password: parsed.password?.key ?? null,
    newPassword: parsed.newPassword?.key ?? null,
    confirmPassword: parsed.confirmPassword?.key ?? null
  }
}

const roles = (
  kind: string,
  username: string | null,
  current: string | null,
  fresh: string | null = null,
  confirm: string | null = null
): Expected => ({
  kind,
  username,
  password: current,
  newPassword: fresh,
  confirmPassword: confirm
})

describe('parsePasswordForm', () => {
  it.each<[string, TestField[], string, Expected]>([
    [
      'plain login',
      [input('email', { type: 'email' }), password('pass')],
      'sign in',
      roles('login', 'email', 'pass')
    ],
    [
      'login by autocomplete, even with the username after the password',
      [
        password('pw', { autocomplete: 'current-password' }),
        input('who', { autocomplete: 'username' })
      ],
      '',
      roles('login', 'who', 'pw')
    ],
    [
      'autocomplete webauthn suffix is dropped',
      [
        input('u', { autocomplete: 'section-a username webauthn' }),
        password('p', { autocomplete: 'current-password webauthn' })
      ],
      '',
      roles('login', 'u', 'p')
    ],
    [
      'sign-up with confirm (typed equal values)',
      [
        input('email'),
        password('pw1', { value: 'hunter2' }),
        password('pw2', { value: 'hunter2' })
      ],
      'create account',
      roles('signup', 'email', null, 'pw1', 'pw2')
    ],
    [
      'sign-up by autocomplete before anything is typed',
      [
        input('email', { autocomplete: 'email' }),
        password('a', { autocomplete: 'new-password' }),
        password('b', { autocomplete: 'new-password' })
      ],
      '',
      roles('signup', 'email', null, 'a', 'b')
    ],
    [
      'change password with three typed fields',
      [
        password('old', { value: 'x' }),
        password('new', { value: 'y' }),
        password('again', { value: 'y' })
      ],
      '',
      roles('change', null, 'old', 'new', 'again')
    ],
    [
      'two different passwords are old + new',
      [password('a', { value: 'x' }), password('b', { value: 'y' })],
      '',
      roles('change', null, 'a', 'b')
    ],
    [
      'two empty passwords are old + new',
      [password('a'), password('b')],
      '',
      roles('change', null, 'a', 'b')
    ],
    [
      'three equal passwords: the first is current',
      [password('a', { value: 'x' }), password('b', { value: 'x' }), password('c', { value: 'x' })],
      '',
      roles('login', null, 'a')
    ],
    [
      'three passwords, first two equal: new + confirm',
      [password('a', { value: 'x' }), password('b', { value: 'x' }), password('c', { value: 'z' })],
      '',
      roles('signup', null, null, 'a', 'b')
    ],
    [
      'three different passwords: the first is current',
      [password('a', { value: 'x' }), password('b', { value: 'y' }), password('c', { value: 'z' })],
      '',
      roles('login', null, 'a')
    ],
    [
      'three empty passwords are the change layout',
      [password('a'), password('b'), password('c')],
      '',
      roles('change', null, 'a', 'b', 'c')
    ],
    [
      'show-password toggle keeps a field that was a password',
      [input('user'), input('pass', { type: 'text', wasPassword: true })],
      '',
      roles('login', 'user', 'pass')
    ],
    [
      'only visible passwords count when any are visible',
      [input('user'), password('hidden', { visible: false }), password('shown')],
      '',
      roles('login', 'user', 'shown')
    ],
    [
      'falls back to hidden passwords when none are visible',
      [input('user'), password('hidden', { visible: false })],
      '',
      roles('login', 'user', 'hidden')
    ],
    [
      'prefers the username-looking field over the last one before the password',
      [input('first_name'), input('login_email'), input('phone', { type: 'tel' }), password('pw')],
      '',
      roles('login', 'login_email', 'pw')
    ],
    [
      'takes the last text field when none looks like a username',
      [input('alpha'), input('beta'), password('pw')],
      '',
      roles('login', 'beta', 'pw')
    ],
    [
      'matches username words in label, placeholder and aria-label',
      [input('f1', { labelText: 'Email address' }), input('f2'), password('pw')],
      '',
      roles('login', 'f1', 'pw')
    ],
    [
      'prefers a focusable username over a hidden one',
      [input('shown'), input('hidden_user', { visible: false }), password('pw')],
      '',
      roles('login', 'shown', 'pw')
    ],
    [
      'a search box next to a formless login is not the username',
      [
        input('email', { type: 'email' }),
        input('q', { placeholder: 'Search docs' }),
        password('pw')
      ],
      '',
      roles('login', 'email', 'pw')
    ],
    [
      'a type=search box is never the username',
      [input('site', { type: 'search' }), password('pw')],
      '',
      roles('login', null, 'pw')
    ],
    [
      'a camelCase search name is a search box',
      [input('searchInput'), password('pw')],
      '',
      roles('login', null, 'pw')
    ],
    [
      'OTP field after a password is ignored',
      [input('user'), password('pw'), input('otp_code', { type: 'tel' })],
      '',
      roles('login', 'user', 'pw')
    ],
    [
      'one-time-code password box is not a password',
      [password('code', { autocomplete: 'one-time-code' })],
      'verify',
      null
    ],
    ['camelCase otp name is excluded', [password('otpCode')], '', null],
    ['SSN and CVC fields are excluded', [input('ssn'), password('card_cvc')], '', null],
    [
      'card fields by autocomplete are excluded',
      [input('num', { autocomplete: 'cc-number' }), password('pin', { autocomplete: 'cc-csc' })],
      '',
      null
    ],
    [
      'disabled password fields are ignored',
      [input('user'), password('pw', { disabled: true })],
      '',
      null
    ],
    [
      'non-text inputs are ignored',
      [input('remember', { type: 'checkbox' }), input('token', { type: 'hidden' })],
      '',
      null
    ]
  ])('%s', (_name, fields, text, expected) => {
    expect(parse(fields, text)).toEqual(expected)
  })

  describe('username-first steps', () => {
    it.each<[string, TestField[], string, string | null]>([
      [
        'Google: autocomplete=username identifier box',
        [input('identifier', { type: 'email', id: 'identifierId', autocomplete: 'username' })],
        'next',
        'identifier'
      ],
      [
        'Microsoft: lone email box in a form that says Next',
        [input('loginfmt', { type: 'email' })],
        'sign in next',
        'loginfmt'
      ],
      [
        'Okta: autocomplete=username with a remember-me checkbox',
        [
          input('identifier', { autocomplete: 'username' }),
          input('rememberMe', { type: 'checkbox' })
        ],
        'sign in',
        'identifier'
      ],
      ['lone autocomplete=email box', [input('mail', { autocomplete: 'email' })], 'go', 'mail'],
      ['lone field without any sign-in wording', [input('city')], 'submit', null],
      [
        'contact form: autocomplete=email beside other fields',
        [input('name'), input('mail', { autocomplete: 'email' }), input('subject')],
        'send',
        null
      ],
      [
        'newsletter email form',
        [input('email', { type: 'email', autocomplete: 'email' })],
        'subscribe to our newsletter',
        null
      ],
      [
        'newsletter by field name',
        [input('newsletter_email', { type: 'email' })],
        'continue',
        null
      ],
      ['lone search box that says next', [input('q', { type: 'search' })], 'next', null]
    ])('%s', (_name, fields, text, username) => {
      const parsed = parse(fields, text)
      expect(parsed ? parsed.username : null).toBe(username)
      if (username) {
        expect(parsed?.kind).toBe('username-only')
      }
    })
  })

  it('reports each classified field role', () => {
    const user = input('user')
    const current = password('old', { value: 'x' })
    const fresh = password('new', { value: 'y' })
    const confirm = password('again', { value: 'y' })
    const other = input('other')
    const parsed = parsePasswordForm({ fields: [user, current, fresh, confirm, other], text: '' })
    expect(parsed).not.toBeNull()
    if (!parsed) {
      return
    }
    expect(
      [user, current, fresh, confirm, other].map((field) => passwordFieldRoleIn(parsed, field))
    ).toEqual(['username', 'password', 'new-password', 'new-password', null])
  })
})

describe('isPlaceholderUsernameValue', () => {
  it.each([
    ['', true],
    ['  Email ', true],
    ['username', true],
    ['Username or email', true],
    ['@example.com', true],
    ['alice@example.com', false],
    ['alice', false]
  ])('%j → %s', (value, expected) => {
    expect(isPlaceholderUsernameValue(value)).toBe(expected)
  })
})
