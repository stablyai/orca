import { expect, it } from 'vitest'
import { botRulesSections, BOT_ORCA_CLI } from './bot-preamble'

it('tells a bot how to guide the owner without claiming to control their screen', () => {
  const { tools } = botRulesSections('codex')
  const guidance = tools.split('\n').find((line) => line.includes('take me to')) ?? ''
  expect(guidance).toContain('Tell them which computer and workspace to open')
  expect(guidance).toContain('give the agent or tab name')
  expect(guidance).toContain(
    // terminal switch is the canonical name of terminal focus; both reach the same window fallback.
    `Never claim you opened something on their screen, and do not use \`${BOT_ORCA_CLI} worktree activate\`, \`${BOT_ORCA_CLI} terminal switch\` or \`${BOT_ORCA_CLI} terminal focus\` for this:`
  )
  expect(guidance).toContain('which may not be the screen your owner is looking at.')
  expect(tools).not.toContain('ORCA ')
})

it('points a bot past the recent list to idle, archived and paired-server workspaces', () => {
  const { tools } = botRulesSections('codex')
  const guidance = tools.split('\n').find((line) => line.includes('take me to')) ?? ''
  // --since drops archived rows and anything idle past the window, so it cannot be the only lookup.
  expect(guidance).toContain(
    `if it is not there (idle longer, or archived), \`${BOT_ORCA_CLI} worktree ps\` lists every workspace on this computer`
  )
  expect(guidance).toContain('add the `--environment` its `scope:` line names')
})
