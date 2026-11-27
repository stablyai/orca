import { expect, it } from 'vitest'
import { doubaoSessionSubmit } from './doubao-composer-context'

it('round-trips the owning profile and terminal without adding another shell command or submit', () => {
  const cli = "C:\\工具 & 客户端\\Orca's 100%!\\orca.exe"
  const profile = 'D:\\QA\\`$profile;^(test)|☃'
  const handle = 'term_123'
  const input = doubaoSessionSubmit(cli, profile, handle)!
  // oxlint-disable-next-line no-control-regex -- the PTY frame contains a single caret motion, paste and submit.
  const frame = /^\x05\x1b\[200~( #[^\r\n\x1b]+)\x1b\[201~\r$/.exec(input)
  expect(frame).not.toBeNull()
  expect(frame![1]).not.toMatch(/[&|<>^%!`$;]/)
  expect(JSON.parse(frame![1].slice(frame![1].indexOf('{')))).toEqual({
    cli,
    ORCA_USER_DATA_PATH: profile,
    ORCA_TERMINAL_HANDLE: handle
  })
  expect(doubaoSessionSubmit('orca', profile, handle)).toBeNull()
})
