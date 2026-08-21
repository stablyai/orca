import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { linearProjectWriteUnconfirmed } from './linear-project-write-recovery'
import type { LinearProjectCreateIntent } from './linear-project-create-intent'
import type { LinearProjectEditIntent } from './linear-project-edit-intent'
import type { LinearProjectUpdateAddIntent } from './linear-project-update-write-intent'

const PROJECT_ID = '0f3a1c9e-2b7d-4a51-9c62-8d5f0e7b4a13'
const WORKSPACE_ID = 'a1b2c3d4-e5f6-4718-9a0b-1c2d3e4f5a6b'
const WRITE_ID = 'b7c8d9e0-1f2a-4b3c-8d4e-5f6a7b8c9d0e'
const PROJECT_NAME = 'Aurora Launch'
const BODY = 'Shipped the beta.\nNext: docs; `rm -rf /` $HOME | tee'

function intent(
  overrides: Partial<LinearProjectUpdateAddIntent> = {}
): LinearProjectUpdateAddIntent {
  return { projectId: PROJECT_ID, body: BODY, isDiffHidden: false, ...overrides }
}

function recoveryData(error: Error): Record<string, unknown> {
  return (error as { data?: Record<string, unknown> }).data ?? {}
}

function retryStep(error: Error): string {
  const steps = recoveryData(error).nextSteps
  return Array.isArray(steps) ? String(steps[0]) : ''
}

describe('linearProjectWriteUnconfirmed for project update posts', () => {
  it('emits one single-line retry command using resolved UUIDs and stdin', () => {
    const error = linearProjectWriteUnconfirmed({
      kind: 'update-add',
      target: { projectId: PROJECT_ID, workspaceId: WORKSPACE_ID },
      writeId: WRITE_ID,
      intent: intent({ health: 'atRisk', isDiffHidden: true })
    })

    const steps = recoveryData(error).nextSteps as string[]
    expect(error.message).toContain('could not confirm')
    expect(steps).toHaveLength(1)
    expect(steps[0]).not.toContain('\n')
    expect(steps[0]).not.toContain('\\')
    expect(steps[0]).toContain(
      `orca linear project update add ${PROJECT_ID} --body-file - --health=at-risk --hide-diff --write-id=${WRITE_ID} --workspace=${WORKSPACE_ID} --json`
    )
    expect(steps[0]).toContain('exact same body on stdin')
  })

  it('never embeds the body or the project name in the retry command', () => {
    const error = linearProjectWriteUnconfirmed({
      kind: 'update-add',
      target: { projectId: PROJECT_ID, workspaceId: WORKSPACE_ID },
      writeId: WRITE_ID,
      intent: intent()
    })

    const step = retryStep(error)
    expect(step).not.toContain(PROJECT_NAME)
    expect(step).not.toContain('Shipped the beta')
    expect(step).not.toContain('rm -rf')
    expect(step).not.toContain('|')
    expect(step).not.toContain('$')
  })

  it('replaces hostile ids with placeholders instead of interpolating them', () => {
    const error = linearProjectWriteUnconfirmed({
      kind: 'update-add',
      target: { projectId: '"; rm -rf ~ #', workspaceId: 'work space' },
      writeId: '`whoami`',
      intent: intent()
    })

    const step = retryStep(error)
    expect(step).toContain(
      'orca linear project update add PROJECT_ID --body-file - --write-id=WRITE_ID --workspace=WORKSPACE_ID --json'
    )
    expect(step).not.toContain('rm -rf')
    expect(step).not.toContain('whoami')
  })

  it('records the resolved ids, normalized intent, and the body count and digest', () => {
    const crlfBody = 'line one\r\nline two\rline three'
    const normalized = 'line one\nline two\nline three'
    const error = linearProjectWriteUnconfirmed({
      kind: 'update-add',
      target: { projectId: PROJECT_ID, workspaceId: WORKSPACE_ID },
      writeId: WRITE_ID,
      intent: intent({ body: crlfBody, health: 'offTrack', isDiffHidden: true }),
      cause: 'Linear write deadline elapsed before confirmation.'
    })

    expect(error).toMatchObject({ code: 'linear_write_unconfirmed' })
    expect(recoveryData(error)).toMatchObject({
      writeId: WRITE_ID,
      projectId: PROJECT_ID,
      workspaceId: WORKSPACE_ID,
      health: 'offTrack',
      isDiffHidden: true,
      bodyChars: normalized.length,
      bodySha256: createHash('sha256').update(normalized, 'utf8').digest('hex'),
      cause: 'Linear write deadline elapsed before confirmation.'
    })
  })

  it('records an absent health request as null and omits an absent cause', () => {
    const error = linearProjectWriteUnconfirmed({
      kind: 'update-add',
      target: { projectId: PROJECT_ID, workspaceId: WORKSPACE_ID },
      writeId: WRITE_ID,
      intent: intent()
    })

    expect(recoveryData(error).health).toBeNull()
    expect(recoveryData(error).isDiffHidden).toBe(false)
    expect(recoveryData(error)).not.toHaveProperty('cause')
  })
})

const TEAM_ID = 'c4d5e6f7-a8b9-4c0d-8e1f-2a3b4c5d6e7f'
const STATUS_ID = 'd5e6f7a8-b9c0-4d1e-9f2a-3b4c5d6e7f80'
const LEAD_ID = 'e6f7a8b9-c0d1-4e2f-8a3b-4c5d6e7f8091'
const LABEL_ID = 'f7a8b9c0-d1e2-4f30-9b4c-5d6e7f8091a2'
const HOSTILE_NAME = 'Aurora "; rm -rf ~ #'
const CONTENT = '# Overview\nShip it; `whoami` $HOME | tee'

function createIntent(
  overrides: Partial<LinearProjectCreateIntent> = {}
): LinearProjectCreateIntent {
  return {
    workspaceId: WORKSPACE_ID,
    name: HOSTILE_NAME,
    teamIds: [TEAM_ID],
    ...overrides
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

// Why: a whitespace-only body is a legal post, but the stdin readers reject blank
// input, so `--body-file -` would hand back a retry that cannot be run.
it.each([' ', '\t', '   '])('inlines a blank update body verbatim (%j)', (body) => {
  const error = linearProjectWriteUnconfirmed({
    kind: 'update-add',
    target: { projectId: PROJECT_ID, workspaceId: WORKSPACE_ID },
    writeId: WRITE_ID,
    intent: intent({ body })
  })

  // Verbatim, because dedup compares the body exactly rather than canonicalizing it.
  expect(retryStep(error)).toContain(`--body="${body}"`)
  expect(retryStep(error)).not.toContain('--body-file -')
  expect(retryStep(error).split('\n')).toHaveLength(1)
})

// Why: no platform-neutral way to put a newline on one line, and a body that fails
// the write-id check on retry is worse than one the agent has to supply by hand.
it.each(['\n', '  \n '])('keeps a newline-bearing blank body on stdin (%j)', (body) => {
  const error = linearProjectWriteUnconfirmed({
    kind: 'update-add',
    target: { projectId: PROJECT_ID, workspaceId: WORKSPACE_ID },
    writeId: WRITE_ID,
    intent: intent({ body })
  })

  expect(retryStep(error)).toContain('--body-file -')
  expect(retryStep(error).split('\n')).toHaveLength(1)
})

describe('linearProjectWriteUnconfirmed for project creates', () => {
  // Why: the agent substitutes the real project name, and an unquoted `Payments V2`
  // used to split into a stray positional that the create spec rejects outright.
  it('survives substituting a name that contains spaces', () => {
    const error = linearProjectWriteUnconfirmed({
      kind: 'create',
      writeId: WRITE_ID,
      intent: createIntent({ name: 'Payments V2' })
    })

    expect(retryStep(error)).toContain('--name="NAME"')
    expect(retryStep(error).replace('NAME', 'Payments V2')).toContain('--name="Payments V2"')
  })

  // Why: both stdin readers reject whitespace-only input, not just empty, so a
  // blank-but-not-empty body still has to travel inline to stay runnable.
  it.each([' ', '\n', '  \n '])('offers a runnable retry for blank content %j', (content) => {
    const error = linearProjectWriteUnconfirmed({
      kind: 'create',
      writeId: WRITE_ID,
      intent: createIntent({ content })
    })

    expect(retryStep(error)).toContain('--content=')
    expect(retryStep(error)).not.toContain('--content-file -')
    expect(retryStep(error)).not.toContain('on stdin')
    // Why: the retry contract is one line; a newline in the value would split it.
    expect(retryStep(error).split('\n')).toHaveLength(1)
  })

  // Why: an agent substitutes the real #RRGGBB into the placeholder, and a
  // space-separated `--color #...` would comment out --write-id on every POSIX
  // shell, turning the idempotent retry into a duplicate-create.
  it('keeps the pinning flags past a substituted hex color on a POSIX shell', () => {
    const error = linearProjectWriteUnconfirmed({
      kind: 'create',
      writeId: WRITE_ID,
      intent: createIntent({ color: '#4EA7FC' })
    })

    const substituted = retryStep(error).replace('COLOR', '#4EA7FC')
    const beforeComment = substituted.split(/(?:^|\s)#/)[0]
    expect(substituted).toContain('--color=#4EA7FC')
    expect(beforeComment).toContain(`--write-id=${WRITE_ID}`)
    expect(beforeComment).toContain('--json')
  })

  // Why: both stdin readers reject blank input, so `--content-file -` would hand
  // back a retry that cannot be run at all.
  it('offers a runnable retry for a create whose content was empty', () => {
    const error = linearProjectWriteUnconfirmed({
      kind: 'create',
      writeId: WRITE_ID,
      intent: createIntent({ content: '' })
    })

    expect(retryStep(error)).toContain('--content=')
    expect(retryStep(error)).not.toContain('--content-file -')
  })

  it('emits one single-line retry command using resolved ids and placeholders', () => {
    const error = linearProjectWriteUnconfirmed({
      kind: 'create',
      writeId: WRITE_ID,
      intent: createIntent({
        description: 'short summary',
        content: CONTENT,
        statusId: STATUS_ID,
        leadId: LEAD_ID,
        memberIds: [LEAD_ID],
        labelIds: [LABEL_ID],
        priority: 0,
        startDate: '2026-01-05',
        targetDate: '2026-02-28',
        color: '#5E6AD2'
      })
    })

    const step = retryStep(error)
    expect(step).not.toContain('\n')
    expect(step).not.toContain('\\')
    expect(step).toContain(
      `orca linear project create --name="NAME" --team=${TEAM_ID} --description="DESCRIPTION" --content-file - --status=${STATUS_ID} --lead=${LEAD_ID} --member=${LEAD_ID} --label=${LABEL_ID} --priority=none --start-date=2026-01-05 --target-date=2026-02-28 --color=COLOR --write-id=${WRITE_ID} --workspace=${WORKSPACE_ID} --json`
    )
    expect(step).toContain('replacing every UPPERCASE placeholder')
  })

  it('never embeds the project name, prose, or color text in the retry command', () => {
    const error = linearProjectWriteUnconfirmed({
      kind: 'create',
      writeId: WRITE_ID,
      intent: createIntent({
        description: 'short summary',
        content: CONTENT,
        color: '#5E6AD2'
      })
    })

    const step = retryStep(error)
    expect(step).not.toContain('Aurora')
    expect(step).not.toContain('rm -rf')
    expect(step).not.toContain('whoami')
    expect(step).not.toContain('short summary')
    expect(step).not.toContain('Overview')
    expect(step).not.toContain('#5E6AD2')
    expect(step).not.toContain('$')
    expect(step).not.toContain('|')
  })

  it('replaces hostile resolved ids with placeholders instead of interpolating them', () => {
    const error = linearProjectWriteUnconfirmed({
      kind: 'create',
      writeId: '`whoami`',
      intent: createIntent({
        workspaceId: 'work space',
        teamIds: ['"; rm -rf ~ #'],
        statusId: '$(id)',
        leadId: 'a b',
        memberIds: ['c d'],
        labelIds: ['e f']
      })
    })

    const step = retryStep(error)
    expect(step).toContain(
      'orca linear project create --name="NAME" --team=TEAM_ID --status=STATUS_ID --lead=LEAD_ID --member=MEMBER_ID --label=LABEL_ID --write-id=WRITE_ID --workspace=WORKSPACE_ID --json'
    )
    expect(step).not.toContain('rm -rf')
    expect(step).not.toContain('whoami')
  })

  it('records resolved ids, normalized field intent, and text counts and digests', () => {
    const error = linearProjectWriteUnconfirmed({
      kind: 'create',
      writeId: WRITE_ID,
      intent: createIntent({
        name: 'Aurora Launch',
        teamIds: [TEAM_ID],
        description: 'one\r\ntwo',
        content: 'alpha\rbeta',
        statusId: STATUS_ID,
        leadId: LEAD_ID,
        memberIds: [LEAD_ID],
        labelIds: [LABEL_ID],
        priority: 0,
        startDate: '2026-01-05',
        targetDate: '2026-02-28',
        color: '#5E6AD2'
      }),
      cause: 'Linear write deadline elapsed before confirmation.'
    })

    expect(error).toMatchObject({ code: 'linear_write_unconfirmed' })
    expect(recoveryData(error)).toMatchObject({
      writeId: WRITE_ID,
      workspaceId: WORKSPACE_ID,
      teamIds: [TEAM_ID],
      statusId: STATUS_ID,
      leadId: LEAD_ID,
      memberIds: [LEAD_ID],
      labelIds: [LABEL_ID],
      priority: 0,
      startDate: '2026-01-05',
      targetDate: '2026-02-28',
      color: '#5E6AD2',
      nameChars: 'Aurora Launch'.length,
      nameSha256: sha256('Aurora Launch'),
      descriptionChars: 'one\ntwo'.length,
      descriptionSha256: sha256('one\ntwo'),
      contentChars: 'alpha\nbeta'.length,
      contentSha256: sha256('alpha\nbeta'),
      cause: 'Linear write deadline elapsed before confirmation.'
    })
  })

  it('omits unrequested create fields from the command and records them as null', () => {
    const error = linearProjectWriteUnconfirmed({
      kind: 'create',
      writeId: WRITE_ID,
      intent: createIntent({ name: 'Aurora Launch' })
    })

    const step = retryStep(error)
    expect(step).toContain(
      `orca linear project create --name="NAME" --team=${TEAM_ID} --write-id=${WRITE_ID} --workspace=${WORKSPACE_ID} --json`
    )
    expect(recoveryData(error)).toMatchObject({
      statusId: null,
      leadId: null,
      memberIds: null,
      labelIds: null,
      priority: null,
      startDate: null,
      targetDate: null,
      color: null,
      descriptionChars: null,
      descriptionSha256: null,
      contentChars: null,
      contentSha256: null
    })
    expect(recoveryData(error)).not.toHaveProperty('cause')
  })

  it('keeps an empty requested description as a real intent with a digest', () => {
    const error = linearProjectWriteUnconfirmed({
      kind: 'create',
      writeId: WRITE_ID,
      intent: createIntent({ description: '' })
    })

    expect(retryStep(error)).toContain('--description="DESCRIPTION"')
    expect(recoveryData(error)).toMatchObject({
      descriptionChars: 0,
      descriptionSha256: sha256('')
    })
  })
})

function editRecovery(
  intent: LinearProjectEditIntent,
  cause?: string
): Parameters<typeof linearProjectWriteUnconfirmed>[0] {
  return {
    kind: 'edit',
    target: { projectId: PROJECT_ID, workspaceId: WORKSPACE_ID },
    intent,
    ...(cause ? { cause } : {})
  }
}

describe('linearProjectWriteUnconfirmed for project field edits', () => {
  it('points at project show instead of a pinned retry, because there is no write id', () => {
    const error = linearProjectWriteUnconfirmed(
      editRecovery({ requested: ['name'], edits: { name: 'Aurora Launch' } })
    )

    const steps = recoveryData(error).nextSteps as string[]
    expect(error.message).toContain('could not confirm')
    expect(steps[0]).not.toContain('\n')
    expect(steps[0]).toContain(
      `orca linear project show ${PROJECT_ID} --workspace ${WORKSPACE_ID} --json`
    )
    expect(steps[0]).toContain('compare the current fields')
    expect(steps.join(' ')).not.toContain('--write-id')
    expect(recoveryData(error)).not.toHaveProperty('writeId')
  })

  it('warns that a collection replacement must not be retried before that read', () => {
    const error = linearProjectWriteUnconfirmed(
      editRecovery({
        requested: ['members', 'labels'],
        edits: { memberIds: [LEAD_ID], labelIds: [] }
      })
    )

    const steps = recoveryData(error).nextSteps as string[]
    expect(steps.join(' ')).toContain('another actor may have edited it')
    expect(recoveryData(error)).toMatchObject({
      requestedFields: ['members', 'labels'],
      memberIds: [LEAD_ID],
      labelIds: []
    })
  })

  it('records resolved ids plus a character count and digest for every requested text field', () => {
    const error = linearProjectWriteUnconfirmed(
      editRecovery(
        {
          requested: ['name', 'description', 'content', 'status', 'lead', 'teams'],
          edits: {
            name: HOSTILE_NAME,
            description: 'one\ntwo',
            content: CONTENT,
            statusId: STATUS_ID,
            leadId: LEAD_ID,
            teamIds: [TEAM_ID]
          }
        },
        'Linear write deadline elapsed before confirmation.'
      )
    )

    expect(error).toMatchObject({ code: 'linear_write_unconfirmed' })
    expect(recoveryData(error)).toMatchObject({
      projectId: PROJECT_ID,
      workspaceId: WORKSPACE_ID,
      statusId: STATUS_ID,
      leadId: LEAD_ID,
      teamIds: [TEAM_ID],
      nameChars: HOSTILE_NAME.length,
      nameSha256: sha256(HOSTILE_NAME),
      descriptionChars: 'one\ntwo'.length,
      descriptionSha256: sha256('one\ntwo'),
      contentChars: CONTENT.length,
      contentSha256: sha256(CONTENT),
      cause: 'Linear write deadline elapsed before confirmation.'
    })
    const steps = (recoveryData(error).nextSteps as string[]).join(' ')
    expect(steps).not.toContain('rm -rf')
    expect(steps).not.toContain('Overview')
  })

  it('records cleared text fields as requested with no digest and omits an absent cause', () => {
    const error = linearProjectWriteUnconfirmed(
      editRecovery({
        requested: ['content', 'lead'],
        edits: { content: null, leadId: null }
      })
    )

    expect(recoveryData(error)).toMatchObject({
      requestedFields: ['content', 'lead'],
      leadId: null,
      contentChars: null,
      contentSha256: null
    })
    expect(recoveryData(error)).not.toHaveProperty('cause')
  })

  it('replaces a hostile project or workspace id with a placeholder', () => {
    const error = linearProjectWriteUnconfirmed({
      kind: 'edit',
      target: { projectId: '`whoami`', workspaceId: 'work space' },
      intent: { requested: ['priority'], edits: { priority: 0 } }
    })

    const steps = recoveryData(error).nextSteps as string[]
    expect(steps[0]).toContain(
      'orca linear project show PROJECT_ID --workspace WORKSPACE_ID --json'
    )
    expect(steps[0]).not.toContain('whoami')
    expect(recoveryData(error).priority).toBe(0)
  })
})
