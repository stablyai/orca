import { z } from 'zod'
import { salvagedOptional, salvagingArray } from '../../../src/shared/zod-salvage'
import { prFlag, prText } from '../session/github-pr-entity-reply-schema'
import { taskMutationEnvelopeSchema } from './task-provider-entity-reply-schema'

// What the Tasks list reads to fill itself for a provider, plus the write that connects a Linear
// account. Checked against the handlers in src/main/runtime/rpc/methods/ — linear.ts:25-43 and
// :101-104, gitlab.ts:66-69, github-repo-work-item-methods.ts, repo.ts — and the shared results
// they return: LinearConnectionStatus in src/shared/linear/workspace-types.ts, GitLabTodo in
// src/shared/gitlab-types.ts:219, and `getStatus()` in src/main/linear/client.ts:164.

const GITLAB_TODO_STATE = ['pending', 'done'] as const

/**
 * Linear account status for provider hydration.
 *
 * The container is required and nothing in it is: use-mobile-tasks-provider-load-actions.tsx:58
 * compares `connected` to `true`, :66 reads `workspaces ?? []`, and :68 walks
 * `selectedWorkspaceId ?? activeWorkspaceId ?? workspaces[0]?.id ?? null`. Main read those members
 * off `null` and threw a property-read TypeError the Tasks screen showed as its load error.
 *
 * `selectedWorkspaceId` keeps an explicit `null`, which is a value this host sends
 * (src/main/linear/client.ts:180) and which the `??` chain at the call site is what interprets.
 *
 * The workspace row is mobile's own `LinearWorkspace` (mobile-tasks-view-state-types.ts:63), not
 * the host's: the picker reads `workspace.id` as its value and match key and
 * `organizationName ?? displayName ?? id` as its label
 * (use-mobile-tasks-provider-view-projection.tsx:76-86), and nothing on this screen reads the rest
 * of what `getStatus` sends. A row without an `id` drops, because it can neither be selected nor
 * matched.
 */
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

/**
 * The GitHub item total for the current filter, asked once per repo and summed.
 *
 * The payload is the number, so the number is the schema. Main's `typeof count === 'number' ? count
 * : 0` fallback is gone from the call site because the reader now answers for it: a reply that is
 * not a number reaches the per-repo `catch` that already swallows a failed count as zero, and logs
 * which repo and why instead of adding a silent zero to the total.
 */
export const githubWorkItemCountSchema = z.number().finite()

/**
 * One GitLab to-do.
 *
 * `id` keys the row, `actionName` is read as `actionName.replace(/_/g, ' ')`, `updatedAt` is
 * forwarded to the sort and the timestamp, `projectPath` is interpolated into the subtitle and is
 * the repository badge's key and label (mobile-tasks-repository-presentation.ts:56-58), and
 * `targetUrl` is what tapping the row opens (mobile-tasks-provider-item-list.tsx:170) as well as
 * the title's fallback. Those five are read with no guard, so they are the five required members;
 * a row without one renders `undefined` in a label or opens nothing, which is the failure this
 * reader exists to stop.
 *
 * Everything else is reached through a guard and stays optional: `targetTitle` behind
 * `targetTitle || targetUrl`, `targetType` behind two `===` tests and `targetIid` behind
 * `!todo.targetIid` (mobile-tasks-item-mapping.ts:237-258), and `authorUsername` and `state` are
 * carried but unread on this screen.
 */
export const gitlabTodoSchema = z.looseObject({
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

/**
 * The GitLab to-do inbox.
 *
 * Nullish as well as an array, because the call site already read a nullish reply as an empty
 * inbox (`todos ?? []`), and a row that does not decode drops rather than failing the whole
 * inbox — one unreadable to-do is not a reason to show none.
 *
 * What the container alone buys is the failure the call site names: a reply that is neither an
 * array nor nullish was `(response.result ?? []).map is not a function` on the screen, and is now
 * one error naming `gitlab.todos`.
 */
export const gitlabTodoListSchema = salvagingArray(gitlabTodoSchema).nullish()

/**
 * Connecting a Linear account with a pasted API key, and the repository issue-source write.
 *
 * The connect reply is the standard envelope: use-mobile-tasks-task-pagination-actions.tsx:56
 * reads `ok === false` and raises `error` or its own copy, and nothing else in the reply.
 */
export const linearAccountConnectedSchema = taskMutationEnvelopeSchema

/**
 * The repository issue-source preference write.
 *
 * Deliberately unread: use-mobile-tasks-task-create-actions.tsx:199 interprets the envelope for
 * its acceptance and then re-reads the repo list rather than patching its cached copy, so there is
 * no member to declare and a narrower reader would only invent a failure the screen never had.
 */
export const taskRepoPreferenceWrittenSchema = z.unknown()
