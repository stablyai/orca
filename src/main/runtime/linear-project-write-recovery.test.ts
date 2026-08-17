import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { linearProjectWriteUnconfirmed } from './linear-project-write-recovery'
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
