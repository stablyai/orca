import { expect, it } from 'vitest'
import { botRulesSections, BOT_ORCA_CLI } from './bot-preamble'

it('gives bots a runnable link command and forbids switching the host window for link requests', () => {
  const { tools } = botRulesSections('codex')
  expect(tools).toContain(
    `${BOT_ORCA_CLI} bot link --worktree <address.worktree> [--agent <orca_session_id>]`
  )
  expect(tools).not.toContain('ORCA ')
  expect(tools).toContain('Do not use `worktree activate` or `terminal focus` for this')
  expect(tools).toContain('never claim you opened something on their screen')
})
