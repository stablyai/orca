import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { linearProjectWriteUnconfirmed } from './linear-project-write-recovery'
import type { LinearProjectCreateIntent } from './linear-project-create-intent'
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
      `orca linear project update add ${PROJECT_ID} --body-file - --write-id=${WRITE_ID} --workspace=${WORKSPACE_ID} --json`
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

describe('linearProjectWriteUnconfirmed for project creates', () => {
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
        color: '#5E6AD2',
        icon: 'Rocket'
      })
    })

    const step = retryStep(error)
    expect(step).not.toContain('\n')
    expect(step).not.toContain('\\')
    expect(step).toContain(
      `orca linear project create --name NAME --team=${TEAM_ID} --description DESCRIPTION --content-file - --status=${STATUS_ID} --lead=${LEAD_ID} --member=${LEAD_ID} --label=${LABEL_ID} --priority=none --start-date=2026-01-05 --target-date=2026-02-28 --color COLOR --icon ICON --write-id=${WRITE_ID} --workspace=${WORKSPACE_ID} --json`
    )
    expect(step).toContain('replacing every UPPERCASE placeholder')
  })

  it('never embeds the project name, prose, icon, or color text in the retry command', () => {
    const error = linearProjectWriteUnconfirmed({
      kind: 'create',
      writeId: WRITE_ID,
      intent: createIntent({
        description: 'short summary',
        content: CONTENT,
        color: '#5E6AD2',
        icon: '🚀 rocket'
      })
    })

    const step = retryStep(error)
    expect(step).not.toContain('Aurora')
    expect(step).not.toContain('rm -rf')
    expect(step).not.toContain('whoami')
    expect(step).not.toContain('short summary')
    expect(step).not.toContain('Overview')
    expect(step).not.toContain('rocket')
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
      'orca linear project create --name NAME --team=TEAM_ID --status=STATUS_ID --lead=LEAD_ID --member=MEMBER_ID --label=LABEL_ID --write-id=WRITE_ID --workspace=WORKSPACE_ID --json'
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
        color: '#5E6AD2',
        icon: 'Rocket'
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
      iconChars: 'Rocket'.length,
      iconSha256: sha256('Rocket'),
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
      `orca linear project create --name NAME --team=${TEAM_ID} --write-id=${WRITE_ID} --workspace=${WORKSPACE_ID} --json`
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
      contentSha256: null,
      iconChars: null,
      iconSha256: null
    })
    expect(recoveryData(error)).not.toHaveProperty('cause')
  })

  it('keeps an empty requested description as a real intent with a digest', () => {
    const error = linearProjectWriteUnconfirmed({
      kind: 'create',
      writeId: WRITE_ID,
      intent: createIntent({ description: '' })
    })

    expect(retryStep(error)).toContain('--description DESCRIPTION')
    expect(recoveryData(error)).toMatchObject({
      descriptionChars: 0,
      descriptionSha256: sha256('')
    })
  })
})
