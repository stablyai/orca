import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import {
  githubWorkItemCountSchema,
  gitlabTodoListSchema,
  linearAccountConnectedSchema,
  linearAccountStatusSchema,
  taskRepoPreferenceWrittenSchema
} from './task-list-reply-schema'

function reads<T>(schema: z.ZodType<T, unknown>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    throw new Error(`expected a readable reply: ${parsed.error.message}`)
  }
  return parsed.data
}

function refuses(schema: z.ZodType<unknown, unknown>, value: unknown): boolean {
  return !schema.safeParse(value).success
}

describe('Linear account status', () => {
  it('reads the recorded reply, workspace row included', () => {
    const status = reads(linearAccountStatusSchema, {
      connected: true,
      workspaces: [{ id: 'linear-workspace', name: 'Workspace' }],
      selectedWorkspaceId: 'linear-workspace'
    })
    expect(status.connected).toBe(true)
    expect(status.workspaces?.[0]).toMatchObject({ id: 'linear-workspace', name: 'Workspace' })
  })

  it('reads a disconnected host the same way every settings family records it', () => {
    expect(reads(linearAccountStatusSchema, { connected: false }).connected).toBe(false)
  })

  it('names the null main read `connected` off, which the screen showed as its load error', () => {
    expect(refuses(linearAccountStatusSchema, null)).toBe(true)
    expect(refuses(linearAccountStatusSchema, 'connected')).toBe(true)
  })

  it('keeps an explicit selectedWorkspaceId null, which the ?? ladder is what interprets', () => {
    const status = reads(linearAccountStatusSchema, {
      connected: true,
      selectedWorkspaceId: null,
      activeWorkspaceId: null
    })
    expect(status.selectedWorkspaceId).toBeNull()
    expect(status.activeWorkspaceId).toBeNull()
  })

  it('drops only the workspace row with no id, which can be neither selected nor matched', () => {
    expect(reads(linearAccountStatusSchema, { workspaces: [{ name: 'W' }] }).workspaces).toEqual([])
    expect(
      reads(linearAccountStatusSchema, { workspaces: [{ id: 'w-1' }, { name: 'W' }] }).workspaces
    ).toEqual([{ id: 'w-1' }])
    expect(reads(linearAccountStatusSchema, { workspaces: 'none' }).workspaces).toBeUndefined()
  })
})

describe('the GitHub item count', () => {
  it('reads the recorded number and names anything else', () => {
    expect(reads(githubWorkItemCountSchema, 4)).toBe(4)
    expect(refuses(githubWorkItemCountSchema, '4')).toBe(true)
    expect(refuses(githubWorkItemCountSchema, { count: 4 })).toBe(true)
    expect(refuses(githubWorkItemCountSchema, null)).toBe(true)
  })
})

describe('the GitLab to-do inbox', () => {
  it('reads the recorded reply through untouched, row and all', () => {
    const recorded = [
      {
        id: 1,
        targetType: 'Issue',
        target: { id: 'gid://1', iid: 4, title: 'A GitLab todo', webUrl: '' }
      }
    ]
    expect(reads(gitlabTodoListSchema, recorded)).toEqual(recorded)
  })

  it('reads nullish as the empty inbox the call site already read', () => {
    expect(reads(gitlabTodoListSchema, null)).toBeNull()
    expect(reads(gitlabTodoListSchema, undefined)).toBeUndefined()
  })

  it('names a reply that is neither, which the screen showed as ".map is not a function"', () => {
    expect(refuses(gitlabTodoListSchema, { todos: [] })).toBe(true)
    expect(refuses(gitlabTodoListSchema, 'none')).toBe(true)
  })
})

describe('the two writes on this surface', () => {
  it('reads the connect envelope and names a reply that is not one', () => {
    expect(reads(linearAccountConnectedSchema, { ok: true }).ok).toBe(true)
    expect(reads(linearAccountConnectedSchema, { ok: false, error: 'bad key' }).error).toBe(
      'bad key'
    )
    expect(refuses(linearAccountConnectedSchema, null)).toBe(true)
  })

  it('reads anything for the repo preference write, whose body the screen never looks at', () => {
    expect(refuses(taskRepoPreferenceWrittenSchema, null)).toBe(false)
    expect(refuses(taskRepoPreferenceWrittenSchema, 'written')).toBe(false)
  })
})
