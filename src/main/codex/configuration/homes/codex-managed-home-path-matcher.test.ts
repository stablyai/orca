import { expect, it } from 'vitest'
import { matchesManagedCodexHomePath } from './codex-managed-home-path-matcher'

it.each([
  [String.raw`\\wsl.localhost\Ubuntu\home\alice\.local\share\orca\codex-accounts\a\home`, true],
  [String.raw`\\wsl$\Ubuntu\root\.local\share\orca\codex-accounts\a\home`, true],
  [String.raw`\\wsl.localhost\Ubuntu\home\alice\.local\share\orca\codex-accounts-backup`, false],
  [String.raw`\\wsl.localhost\Ubuntu\home\alice\.local\share\orca\Codex-accounts\a\home`, false]
] as const)('classifies the WSL instruction source %s as managed=%s', (source, expected) => {
  expect(
    matchesManagedCodexHomePath(
      source,
      String.raw`C:\orca\codex-accounts\b\home`,
      String.raw`C:\orca\codex-accounts`
    )
  ).toBe(expected)
})
