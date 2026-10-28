import { z } from 'zod'
import { salvagedOptional, salvagingArray } from '../../../src/shared/zod-salvage'
import { prFlag, prText } from '../session/github-pr-entity-reply-schema'
import { taskMutationEnvelopeSchema } from './task-provider-entity-reply-schema'

const GITLAB_TODO_STATE = ['pending', 'done'] as const

// Require the status container and workspace ids; guarded account fields stay optional and selectedWorkspaceId retains null.
export const linearAccountStatusSchema = z.looseObject({
  connected: prFlag('connected'),
  workspaces: salvagedOptional(
    'workspaces',
    salvagingArray(
      z.looseObject({
        id: z.string(),
        organizationName: prText('organizationName'),
        displayName: prText('displayName')
      })
    )
  ),
  selectedWorkspaceId: salvagedOptional('selectedWorkspaceId', z.string().nullable()),
  activeWorkspaceId: salvagedOptional('activeWorkspaceId', z.string().nullable())
})

// Non-number totals fail into the per-repo catch, which already counts failed reads as zero.
export const githubWorkItemCountSchema = z.number().finite()

// Require only the five unguarded fields: row id, action text, sort timestamp, project badge and tap URL.
const gitlabTodoSchema = z.looseObject({
  id: z.number().finite(),
  actionName: z.string(),
  targetType: prText('targetType'),
  targetIid: salvagedOptional('targetIid', z.number().finite().nullable()),
  targetTitle: prText('targetTitle'),
  targetUrl: z.string(),
  projectPath: z.string(),
  authorUsername: prText('authorUsername'),
  updatedAt: z.string(),
  state: salvagedOptional('state', z.enum(GITLAB_TODO_STATE))
})

// Nullish replies are empty inboxes; salvage individual bad todos without losing readable rows.
export const gitlabTodoListSchema = salvagingArray(gitlabTodoSchema).nullish()

export const linearAccountConnectedSchema = taskMutationEnvelopeSchema

// Preference writers reload repo state; only acceptance is consumed, so payload fields stay unconstrained.
export const taskRepoPreferenceWrittenSchema = z.unknown()
