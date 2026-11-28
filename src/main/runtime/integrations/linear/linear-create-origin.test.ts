import { describe, expect, it } from 'vitest'
import { checkLinearCreateOrigin, type LinearCreateAuthority } from './linear-create-origin'

const workspaceId = '00000000-0000-4000-8000-000000000001'
const projectId = '00000000-0000-4000-8000-000000000002'
const botId = '00000000-0000-4000-8000-000000000003'
const otherProject = '00000000-0000-4000-8000-000000000004'

describe('Linear issue create origin', () => {
  it('identifies a missing origin in the headless host language', async () => {
    await expect(checkLinearCreateOrigin(null, workspaceId, projectId)).rejects.toThrow(
      'The request origin could not be identified.'
    )
  })

  it('keeps a queued write bound to its original project and turn', async () => {
    const questions: string[] = []
    let current = true
    const authority: LinearCreateAuthority = {
      requestId: 'initial-request',
      replyTo: 'original-issue',
      readCurrent: async () => ({
        requestId: 'initial-request',
        receivingBotId: botId,
        original: { workspaceId, projectId },
        assignment: { botId, project: { workspaceId, projectId } }
      }),
      stillCurrent: async () => current,
      askOriginOnce: async () => {
        questions.push('original-issue')
        return {
          requestId: 'initial-request',
          destination: 'original-issue',
          messageId: 'question'
        }
      }
    }
    const fence = await checkLinearCreateOrigin(authority, workspaceId, projectId)
    expect(await fence.current()).toBe(true)
    current = false
    expect(await fence.current()).toBe(false)
    await expect(checkLinearCreateOrigin(authority, workspaceId, otherProject)).rejects.toThrow()
    expect(questions).toEqual(['original-issue'])
  })
})
