import { assert, describe, expect, it } from 'vitest'
import { acquired, fakeCodex } from './codex-structured-session-adapter-fixture'
import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import { queuedMessageWithEdit, type QueuedMessageEdit } from '../../shared/queued-message-edit'

function skill(name: string, path: string, enabled = true) {
  return { name, path, description: `${name} skill`, scope: 'user', enabled }
}

const PERSONAL_REVIEW = '/home/me/.agents/skills/review/SKILL.md'
const REPO_REVIEW = '/work/repo/.agents/skills/review/SKILL.md'
const PET = '/home/me/.codex/plugins/cache/work/pets/skills/create-pet/SKILL.md'

async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) {
    await Promise.resolve()
  }
}

describe('a running Codex chat lists and runs the skills Codex loaded', () => {
  it('reports Codex names and files, re-lists on change, and sends a pick by its file', async () => {
    let listed = [
      skill('review', PERSONAL_REVIEW),
      skill('review', REPO_REVIEW),
      skill('work-pets:create-pet', PET),
      skill('old', '/home/me/.agents/skills/old/SKILL.md', false)
    ]
    const codex = fakeCodex({
      'skills/list': () => ({ data: [{ cwd: '/work/repo', skills: listed, errors: [] }] }),
      'turn/start': () => ({ turn: { id: 'turn-1' } })
    })
    const adapter = await acquired(codex)
    await settle()

    const reported = adapter.readCommands('session-1') ?? []
    expect(reported.filter((row) => row.kind === 'command').map((row) => row.name)).toEqual(
      expect.arrayContaining(['model', 'clear', 'compact', 'goal'])
    )
    expect(reported.filter((row) => row.kind === 'skill')).toEqual(
      listed
        .filter(({ enabled }) => enabled)
        .map(({ name, path, description }) => ({
          name,
          path,
          description,
          kind: 'skill'
        }))
    )

    listed = [...listed, skill('fresh', '/home/me/.agents/skills/fresh/SKILL.md')]
    codex.connections[0].handlers.onNotification?.('skills/changed', {})
    await settle()
    expect(
      codex.connections[0].calls.findLast((call) => call.method === 'skills/list')
    ).toMatchObject({ params: { cwds: ['/work/repo'], forceReload: true } })
    expect(adapter.readCommands('session-1')?.some((row) => row.name === 'fresh')).toBe(true)

    await adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'pick-1',
      fence: 7,
      body: {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: '$review this, then $gone' }],
        skills: [
          { name: 'review', path: REPO_REVIEW },
          // Removed from the text after selection.
          { name: 'work-pets:create-pet', path: PET },
          // Unloaded paths remain plain $name text.
          { name: 'gone', path: '/elsewhere/gone/SKILL.md' }
        ]
      }
    })
    expect(
      codex.connections[0].calls.findLast((call) => call.method === 'turn/start')?.params?.input
    ).toEqual([
      { type: 'text', text: '$review this, then $gone' },
      { type: 'skill', name: 'review', path: REPO_REVIEW }
    ])

    const text = 'project: $review personal: $review'
    const skills = [
      { name: 'review', path: REPO_REVIEW },
      { name: 'review', path: PERSONAL_REVIEW }
    ]
    const body: AgentJournalMessageItem = {
      kind: 'message',
      role: 'user',
      blocks: [
        { type: 'text', text },
        { type: 'image-ref', path: '/work/repo/example.png' }
      ],
      sentAs: 'goal',
      from: { kind: 'agent', senders: [], orchestration: null },
      skills
    }
    const { blocks: _blocks, skills: _picks, ...retainedFields } = body
    const edit = (body: AgentJournalMessageItem, input: QueuedMessageEdit) => {
      const result = queuedMessageWithEdit(body, input)
      assert(result.ok)
      return result.body
    }
    const unchanged = edit(body, { text })
    expect(unchanged).toBe(body)
    expect(unchanged.skills).toBe(skills)
    const deleted = edit(body, { text: 'later' })
    const retyped = edit(deleted, { text })
    for (const [edited, expectedSkills] of [
      [unchanged, skills],
      [edit(body, { text: 'project: $review' }), []],
      [edit(body, { text: `${text} please` }), []],
      [
        edit(body, {
          text,
          images: [{ type: 'image-ref', path: '/work/repo/example.png', alt: 'edited' }]
        }),
        []
      ],
      [retyped, []],
      [edit(body, { text: '/review', skills: [{ name: 'review', path: REPO_REVIEW }] }), []]
    ] as const) {
      expect(edited).toMatchObject(retainedFields)
      const adapter = await acquired(codex)
      await settle()
      const connection = codex.connections.at(-1)!
      await adapter.dispatch({
        sessionId: 'session-1',
        clientMessageId: 'queued-pick',
        fence: 7,
        body: edited
      })
      expect(connection.calls.find((call) => call.method === 'turn/start')?.params?.input).toEqual([
        ...edited.blocks.filter((block) => block.type === 'text'),
        { type: 'localImage', path: '/work/repo/example.png' },
        ...expectedSkills.map((s) => ({ type: 'skill', ...s }))
      ])
    }
  })

  it('reports nothing when Codex has no skills/list, so the client keeps its scan', async () => {
    const codex = fakeCodex({
      'skills/list': () => {
        throw new Error(
          'Invalid request: unknown variant `skills/list`, expected one of `initialize`'
        )
      }
    })
    const adapter = await acquired(codex)
    await settle()
    codex.connections[0].handlers.onNotification?.('skills/changed', {})
    await settle()
    expect(adapter.readCommands('session-1')).toBeUndefined()
    expect(codex.connections[0].calls.filter((call) => call.method === 'skills/list')).toHaveLength(
      1
    )
  })
})
