import { expect, it } from 'vitest'
import { botRulesSections, BOT_ORCA_CLI } from './bot-preamble'

it('tells a bot how to guide the owner without claiming to control their screen', () => {
  const { tools } = botRulesSections('codex')
  const guidance = tools.split('\n').find((line) => line.includes('take me to')) ?? ''
  expect(guidance).toContain('Tell them which computer and workspace to open')
  expect(guidance).toContain('give the agent or tab name')
  expect(guidance).toContain(
    `Do not use \`${BOT_ORCA_CLI} worktree activate\` or \`${BOT_ORCA_CLI} terminal focus\``
  )
  expect(guidance).toContain('can fall back to the desktop on the computer running the command')
  expect(guidance).toContain('Never claim you opened something on their screen.')
  expect(tools).not.toContain('ORCA ')
})
