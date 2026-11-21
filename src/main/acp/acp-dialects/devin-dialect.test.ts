import { expect, it } from 'vitest'
import { AcpStructuredOptions } from '../options/acp-structured-options'
import { DEVIN_ACP_DIALECT } from './devin-dialect'

// Captured from Devin 3000.14.30821's `available_commands_update` as a session starts.
const commands = [
  {
    name: 'login',
    description: 'Authenticate with an API key',
    input: { hint: '[api-key]' },
    _meta: { 'cognition.ai/category': 'Account' }
  },
  {
    name: 'logout',
    description: 'Clear authentication',
    _meta: { 'cognition.ai/category': 'Account' }
  },
  {
    name: 'status',
    description: 'Check authentication status',
    _meta: { 'cognition.ai/category': 'Account' }
  },
  {
    name: 'ask',
    description: 'Switch to Ask mode (read-only)',
    _meta: { 'cognition.ai/category': 'Session' }
  },
  {
    name: 'plan',
    description: 'Switch to Plan mode, or plan with a prompt',
    _meta: { 'cognition.ai/category': 'Session' }
  },
  {
    name: 'code',
    description: 'Switch to Code mode, or run a prompt in it',
    _meta: { 'cognition.ai/category': 'Session' }
  },
  {
    name: 'smart',
    description: 'Switch to Smart mode, or run a prompt under it',
    _meta: { 'cognition.ai/category': 'Session' }
  },
  {
    name: 'bypass',
    description: 'Switch to Bypass Permissions mode, or run a prompt under it',
    _meta: { 'cognition.ai/category': 'Session' }
  },
  {
    name: 'compact',
    description: 'Force conversation compaction',
    _meta: { 'cognition.ai/category': 'Session' }
  },
  {
    name: 'context',
    description: 'Show context window usage',
    _meta: { 'cognition.ai/category': 'Session' }
  }
]

it('withholds exactly the commands that switch the session mode behind the picker', () => {
  const switching = commands
    .filter((command) => command.description.startsWith('Switch to '))
    .map((command) => command.name)
  expect([...DEVIN_ACP_DIALECT.withheldCommands!].sort()).toEqual(
    [...switching, 'login', 'logout'].sort()
  )
})

it('keeps the rest of the session commands, and leaves out the withheld ones', () => {
  const options = new AcpStructuredOptions(DEVIN_ACP_DIALECT)
  options.adoptCommands(commands)
  expect(options.readCommands()?.map((command) => command.name)).toEqual([
    'status',
    'compact',
    'context'
  ])
})
