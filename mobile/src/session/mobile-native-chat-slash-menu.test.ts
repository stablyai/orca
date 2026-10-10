import { describe, expect, it } from 'vitest'
import type { AgentSessionConversationCommand } from '../../../src/shared/agent-session-conversation-command'
import type { AgentSessionSlashCommand } from '../../../src/shared/agent-session-wire'
import { nativeChatComposerCatalog } from '../../../src/shared/native-chat-composer-catalog'
import { getMobileNativeChatCommands } from './mobile-native-chat-send-classification'
import { mobileNativeChatSlashMenu } from './mobile-native-chat-slash-menu'

const names = (items: readonly { name: string }[]): string[] => items.map(({ name }) => name)

function menu({
  agent = 'claude',
  lane = 'structured',
  conversationCommands = [],
  sessionCommands,
  query = ''
}: {
  agent?: string | null
  lane?: 'structured' | 'terminal'
  conversationCommands?: readonly AgentSessionConversationCommand[]
  sessionCommands?: readonly AgentSessionSlashCommand[]
  query?: string
}): ReturnType<typeof mobileNativeChatSlashMenu> {
  const catalog = agent
    ? nativeChatComposerCatalog(
        agent,
        getMobileNativeChatCommands(agent),
        lane === 'structured' ? { sessionCommands, conversationCommands } : undefined
      )
    : null
  return mobileNativeChatSlashMenu({ agent, catalog, query })
}

const CLAUDE_REPORT: AgentSessionSlashCommand[] = [
  { name: 'review', kind: 'command', description: 'Review a pull request', argumentHint: '<pr>' },
  { name: 'init', kind: 'command' },
  { name: 'preview-deploy', kind: 'command', description: 'Ship a preview' },
  { name: 'triage', kind: 'skill', description: 'Sort incoming issues' },
  { name: 'dataviz', kind: 'skill', description: 'Build charts' }
]

describe('mobileNativeChatSlashMenu', () => {
  it('serves an older structured host its host-owned commands, by support', () => {
    const full = menu({ conversationCommands: ['clear', 'compact'] })
    expect(names(full.commands)).toEqual(['model', 'effort', 'clear', 'compact'])
    expect(full.skills).toEqual([])
    expect(full.grouped).toBe(false)
    expect(names(menu({ conversationCommands: ['clear'] }).commands)).toEqual([
      'model',
      'effort',
      'clear'
    ])
    expect(names(menu({ conversationCommands: [] }).commands)).toEqual(['model', 'effort'])
  })

  it('shows the commands and skills a Claude session reports, with their text', () => {
    const result = menu({
      conversationCommands: ['clear', 'compact'],
      sessionCommands: CLAUDE_REPORT
    })
    expect(result.grouped).toBe(true)
    expect(names(result.commands)).toEqual(['review', 'init', 'preview-deploy'])
    expect(result.commands[0]).toMatchObject({
      kind: 'command',
      token: '/review',
      description: 'Review a pull request',
      argumentHint: '<pr>'
    })
    // Curated text covers a reported name that came without its own.
    expect(result.commands[1]).toMatchObject({ description: 'Initialize a CLAUDE.md' })
    expect(result.skills).toEqual([
      expect.objectContaining({ kind: 'skill', token: '/dataviz', description: 'Build charts' }),
      expect.objectContaining({
        kind: 'skill',
        token: '/triage',
        description: 'Sort incoming issues'
      })
    ])
  })

  it('ranks with the shared policy: exact, prefix, substring, letters, description', () => {
    const result = menu({
      sessionCommands: [
        { name: 'my-review', kind: 'command' },
        { name: 'r-e-v-i-e-w', kind: 'command' },
        { name: 'summarize', kind: 'command', description: 'Write a review summary' },
        { name: 'review-all', kind: 'command' },
        { name: 'review', kind: 'command' },
        { name: 'unrelated', kind: 'command' }
      ],
      query: 'review'
    })
    expect(names(result.commands)).toEqual([
      'review',
      'review-all',
      'my-review',
      'r-e-v-i-e-w',
      'summarize'
    ])
    expect(names(menu({ sessionCommands: CLAUDE_REPORT, query: 'rev' }).commands)).toEqual([
      'review',
      'preview-deploy'
    ])
    expect(names(menu({ sessionCommands: CLAUDE_REPORT, query: 'charts' }).skills)).toEqual([
      'dataviz'
    ])
  })

  it('keeps Codex on its fallback, including /goal, with no skills group', () => {
    const result = menu({ agent: 'codex', conversationCommands: [], sessionCommands: undefined })
    expect(names(result.commands)).toContain('goal')
    expect(result.skills).toEqual([])
    expect(result.grouped).toBe(false)
  })

  it('serves the terminal lane its curated catalog and never session skills', () => {
    const result = menu({ lane: 'terminal', sessionCommands: CLAUDE_REPORT })
    expect(names(result.commands)).toEqual(names(getMobileNativeChatCommands('claude')))
    expect(result.skills).toEqual([])
  })

  it.each(['omp', 'openclaude'])(
    "leaves %s's /context out of the terminal lane; only desktop can answer it",
    (agent) => {
      expect(names(menu({ agent, lane: 'terminal' }).commands)).not.toContain('context')
    }
  )

  it('groups by whether the session reports skills, whatever the query', () => {
    expect(menu({ sessionCommands: CLAUDE_REPORT }).grouped).toBe(true)
    const commandsOnly = menu({ sessionCommands: CLAUDE_REPORT, query: 'rev' })
    expect(commandsOnly.grouped).toBe(true)
    expect(commandsOnly.skills).toEqual([])
    const withoutSkills = CLAUDE_REPORT.filter(({ kind }) => kind === 'command')
    for (const query of ['', 'rev', 'zzz']) {
      expect(menu({ sessionCommands: withoutSkills, query }).grouped).toBe(false)
    }
  })

  it('is empty without an agent', () => {
    expect(menu({ agent: null })).toEqual({ grouped: false, commands: [], skills: [] })
  })

  it('caps each group at 50 after filtering the whole catalog', () => {
    const sessionCommands = Array.from({ length: 200 }, (_, index) => ({
      name: `cmd-${String(index).padStart(3, '0')}`,
      kind: 'command' as const
    }))
    expect(menu({ sessionCommands }).commands).toHaveLength(50)
    expect(names(menu({ sessionCommands, query: 'cmd-199' }).commands)).toEqual(['cmd-199'])
  })

  it('orders skills by name, since the phone has no disk scope to rank on', () => {
    const result = menu({
      sessionCommands: [
        { name: 'zebra', kind: 'skill' },
        { name: 'alpha', kind: 'skill' }
      ]
    })
    expect(names(result.skills)).toEqual(['alpha', 'zebra'])
  })

  it('leaves an unclassified pre-init name as a command until the session classifies it', () => {
    const result = menu({
      sessionCommands: [{ name: 'project-skill', kind: 'command', kindUnspecified: true }]
    })
    expect(result.commands).toEqual([
      expect.objectContaining({ kind: 'command', name: 'project-skill' })
    ])
    expect(result.skills).toEqual([])
  })

  it('treats an empty report as authoritative instead of reviving the fallback', () => {
    expect(menu({ conversationCommands: ['clear', 'compact'], sessionCommands: [] })).toEqual({
      grouped: false,
      commands: [],
      skills: []
    })
  })
})
