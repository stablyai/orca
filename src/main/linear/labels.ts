/* eslint-disable max-lines -- Why: Linear label catalog reads and mutations share
   workspace/auth handling, so keeping them together avoids drift. */
import type { LinearClient } from '@linear/sdk'
import type {
  LinearIssueLabel,
  LinearIssueLabelCreateInput,
  LinearIssueLabelMutationResult,
  LinearIssueLabelUpdateInput,
  LinearWorkspaceSelection
} from '../../shared/types'
import {
  acquire,
  clearToken,
  getClients,
  getStatus,
  isAuthError,
  release,
  type LinearClientForWorkspace
} from './client'

type LinearSdkIssueLabelCreateInput = Parameters<LinearClient['createIssueLabel']>[0]
type LinearSdkIssueLabelUpdateInput = Parameters<LinearClient['updateIssueLabel']>[1]

type Relation<T> = Promise<T | null | undefined> | T | null | undefined

type LinearIssueLabelNode = {
  id: string
  name: string
  color: string
  description?: string | null
  isGroup?: boolean
  archivedAt?: Date | string | null
  retiredAt?: Date | string | null
  retiredBy?: Relation<{ id: string }>
  team?: Relation<{ id: string; name: string }>
  parent?: Relation<{ id: string; name: string }>
}

type LinearIssueLabelConnection = {
  nodes?: LinearIssueLabelNode[]
  pageInfo?: {
    hasNextPage?: boolean
    endCursor?: string | null
  }
}

type LinearIssueLabelsResponse = {
  issueLabels?: LinearIssueLabelConnection
}

type LinearIssueLabelResponse = {
  issueLabel?: LinearIssueLabelNode | null
}

type LinearRawVariables = Record<string, unknown>

type LinearIssueLabelPayload = {
  success?: boolean
  issueLabel?: Relation<LinearIssueLabelNode>
}

export type ListIssueLabelsOptions = {
  workspaceId?: LinearWorkspaceSelection | null
  teamId?: string | null
  includeArchived?: boolean
}

const LINEAR_ISSUE_LABEL_NODE_FIELDS = `
  id
  name
  color
  description
  isGroup
  archivedAt
  retiredBy {
    id
  }
  team {
    id
    name
  }
  parent {
    id
    name
  }
`

const ISSUE_LABELS_QUERY = `
  query OrcaLinearIssueLabels(
    $first: Int,
    $after: String,
    $filter: IssueLabelFilter,
    $includeArchived: Boolean
  ) {
    issueLabels(first: $first, after: $after, filter: $filter, includeArchived: $includeArchived) {
      nodes {
        ${LINEAR_ISSUE_LABEL_NODE_FIELDS}
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`

const ISSUE_LABEL_QUERY = `
  query OrcaLinearIssueLabel($id: String!) {
    issueLabel(id: $id) {
      ${LINEAR_ISSUE_LABEL_NODE_FIELDS}
    }
  }
`

async function resolveOptionalRelation<T>(value: Relation<T>): Promise<T | undefined> {
  return (await value) ?? undefined
}

function dateToString(value: Date | string | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null
  }
  return value instanceof Date ? value.toISOString() : value
}

async function mapIssueLabelForWorkspace(
  entry: LinearClientForWorkspace,
  label: LinearIssueLabelNode
): Promise<LinearIssueLabel> {
  const [team, parent, retiredBy] = await Promise.all([
    resolveOptionalRelation(label.team),
    resolveOptionalRelation(label.parent),
    resolveOptionalRelation(label.retiredBy)
  ])

  const retiredAt = dateToString(label.retiredAt ?? label.archivedAt)

  return {
    id: label.id,
    name: label.name,
    color: label.color,
    description: label.description ?? null,
    teamId: team?.id,
    teamName: team?.name,
    parentId: parent?.id,
    parentName: parent?.name,
    isGroup: label.isGroup ?? false,
    retiredAt,
    isRetired: Boolean(retiredAt || retiredBy),
    workspaceId: entry.workspace.id,
    workspaceName: entry.workspace.organizationName
  }
}

function shouldThrowAuthError(selection: LinearWorkspaceSelection | null | undefined): boolean {
  return selection !== 'all'
}

function buildLabelFilter(teamId?: string | null): Record<string, unknown> | undefined {
  if (!teamId) {
    return undefined
  }
  return { team: { id: { eq: teamId } } }
}

function isMappedIssueLabelRetired(label: LinearIssueLabel): boolean {
  return label.isRetired
}

async function fetchAllIssueLabelNodes(
  entry: LinearClientForWorkspace,
  options: ListIssueLabelsOptions
): Promise<LinearIssueLabelNode[]> {
  const nodes: LinearIssueLabelNode[] = []
  const filter = buildLabelFilter(options.teamId)
  let after: string | undefined

  do {
    const result = await entry.client.client.rawRequest<
      LinearIssueLabelsResponse,
      LinearRawVariables
    >(ISSUE_LABELS_QUERY, {
      first: 100,
      includeArchived: options.includeArchived ?? false,
      ...(filter ? { filter } : {}),
      ...(after ? { after } : {})
    })
    const labels = result.data?.issueLabels
    nodes.push(...(labels?.nodes ?? []))
    after = labels?.pageInfo?.hasNextPage ? (labels.pageInfo.endCursor ?? undefined) : undefined
  } while (after)

  return nodes
}

async function fetchIssueLabelNode(
  entry: LinearClientForWorkspace,
  id: string
): Promise<LinearIssueLabelNode | null> {
  const result = await entry.client.client.rawRequest<LinearIssueLabelResponse, LinearRawVariables>(
    ISSUE_LABEL_QUERY,
    { id }
  )
  return result.data?.issueLabel ?? null
}

export async function listIssueLabels(
  options: ListIssueLabelsOptions = {}
): Promise<LinearIssueLabel[]> {
  const entries = getClients(options.workspaceId)
  if (entries.length === 0) {
    return []
  }

  const results = await Promise.all(
    entries.map(async (entry) => {
      await acquire()
      try {
        const labels = await fetchAllIssueLabelNodes(entry, options)
        const mappedLabels = await Promise.all(
          labels.map((label) => mapIssueLabelForWorkspace(entry, label))
        )
        return options.includeArchived
          ? mappedLabels
          : mappedLabels.filter((label) => !isMappedIssueLabelRetired(label))
      } catch (error) {
        if (isAuthError(error)) {
          clearToken(entry.workspace.id)
        } else {
          console.warn('[linear] listIssueLabels failed:', error)
        }
        if (shouldThrowAuthError(options.workspaceId)) {
          throw error
        }
        return []
      } finally {
        release()
      }
    })
  )

  return results.flat().sort((a, b) => a.name.localeCompare(b.name))
}

function singleWorkspaceEntry(
  workspaceId?: string | null
): { ok: true; entry: LinearClientForWorkspace } | { ok: false; error: string } {
  if (workspaceId === 'all' || (workspaceId == null && getStatus().selectedWorkspaceId === 'all')) {
    return { ok: false, error: 'Select a single Linear workspace before editing labels.' }
  }

  const entry = getClients(workspaceId)[0]
  if (!entry) {
    return { ok: false, error: 'Not connected to Linear' }
  }

  return { ok: true, entry }
}

function compactCreateInput(input: LinearIssueLabelCreateInput): LinearSdkIssueLabelCreateInput {
  const payload: LinearSdkIssueLabelCreateInput = { name: input.name }
  if (input.color !== undefined) {
    payload.color = input.color
  }
  if (input.description !== undefined) {
    payload.description = input.description
  }
  if (input.teamId !== undefined) {
    payload.teamId = input.teamId
  }
  if (input.parentId !== undefined) {
    payload.parentId = input.parentId
  }
  if (input.isGroup !== undefined) {
    payload.isGroup = input.isGroup
  }
  return payload
}

function compactUpdateInput(input: LinearIssueLabelUpdateInput): LinearSdkIssueLabelUpdateInput {
  const payload: LinearSdkIssueLabelUpdateInput = {}
  if (input.name !== undefined) {
    payload.name = input.name
  }
  if (input.color !== undefined) {
    payload.color = input.color
  }
  if (input.description !== undefined) {
    payload.description = input.description
  }
  if (input.parentId !== undefined) {
    payload.parentId = input.parentId
  }
  if (input.isGroup !== undefined) {
    payload.isGroup = input.isGroup
  }
  return payload
}

async function runLabelMutation(
  workspaceId: string | null | undefined,
  failureMessage: string,
  mutate: (entry: LinearClientForWorkspace) => Promise<LinearIssueLabelPayload>
): Promise<LinearIssueLabelMutationResult> {
  const resolved = singleWorkspaceEntry(workspaceId)
  if (!resolved.ok) {
    return { ok: false, error: resolved.error }
  }

  await acquire()
  try {
    const result = await mutate(resolved.entry)
    if (!result.success) {
      return { ok: false, error: failureMessage }
    }

    const committedWarning = 'Linear label mutation succeeded but label could not be retrieved'
    let label: LinearIssueLabelNode | undefined
    try {
      label = await resolveOptionalRelation(result.issueLabel)
    } catch (error) {
      if (isAuthError(error)) {
        clearToken(resolved.entry.workspace.id)
      }
      return { ok: true, label: null, warning: committedWarning }
    }
    if (!label?.id) {
      return { ok: true, label: null, warning: committedWarning }
    }

    try {
      const hydratedLabel = await fetchIssueLabelNode(resolved.entry, label.id)
      if (!hydratedLabel) {
        return { ok: true, label: null, warning: committedWarning }
      }
      return {
        ok: true,
        label: await mapIssueLabelForWorkspace(resolved.entry, hydratedLabel)
      }
    } catch (error) {
      if (isAuthError(error)) {
        clearToken(resolved.entry.workspace.id)
      }
      return { ok: true, label: null, warning: committedWarning }
    }
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(resolved.entry.workspace.id)
      throw error
    }
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: message }
  } finally {
    release()
  }
}

export async function createIssueLabel(
  input: LinearIssueLabelCreateInput,
  workspaceId?: string | null
): Promise<LinearIssueLabelMutationResult> {
  return runLabelMutation(
    workspaceId,
    'Linear label create failed',
    (entry) =>
      entry.client.createIssueLabel(compactCreateInput(input)) as Promise<LinearIssueLabelPayload>
  )
}

export async function updateIssueLabel(
  id: string,
  input: LinearIssueLabelUpdateInput,
  workspaceId?: string | null
): Promise<LinearIssueLabelMutationResult> {
  return runLabelMutation(
    workspaceId,
    'Linear label update failed',
    (entry) =>
      entry.client.updateIssueLabel(
        id,
        compactUpdateInput(input)
      ) as Promise<LinearIssueLabelPayload>
  )
}

export async function retireIssueLabel(
  id: string,
  workspaceId?: string | null
): Promise<LinearIssueLabelMutationResult> {
  return runLabelMutation(
    workspaceId,
    'Linear label retire failed',
    (entry) => entry.client.issueLabelRetire(id) as Promise<LinearIssueLabelPayload>
  )
}

export async function restoreIssueLabel(
  id: string,
  workspaceId?: string | null
): Promise<LinearIssueLabelMutationResult> {
  return runLabelMutation(
    workspaceId,
    'Linear label restore failed',
    (entry) => entry.client.issueLabelRestore(id) as Promise<LinearIssueLabelPayload>
  )
}
