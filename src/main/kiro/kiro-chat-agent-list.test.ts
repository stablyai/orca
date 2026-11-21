import { expect, it } from 'vitest'
import { parseKiroChatAgentList } from './kiro-chat-agent-list'

it('lists Kiro agent rows once, ignoring headings and wrapped descriptions', () => {
  const output = [
    'Workspace: /work/.kiro/agents',
    'Global: ~/.kiro/agents',
    '* team/reviewer  Workspace  Review this project',
    '                 Wrap the description',
    '  kiro_default   (Built-in)    Default assistant',
    '  code review    Global        Project reviewer',
    '  team/reviewer  Global     Global fallback'
  ].join('\n')
  expect(parseKiroChatAgentList(output)).toEqual(['team/reviewer', 'code review'])
})
