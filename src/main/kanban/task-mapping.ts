import { KANBAN_SERVER_URL } from '../../shared/kanban-types'
import type {
  KanbanLane,
  KanbanTaskDetails,
  KanbanTaskSummary,
  KanbanViewer
} from '../../shared/kanban-types'
import {
  BROKEN,
  isRecord,
  mapAttachment,
  mapComment,
  mapLane,
  mapLaneObject,
  mapList,
  mapNullablePerson,
  mapPersonList,
  mapSubtask,
  nonEmptyString,
  readNullableString,
  readOptionalBoolean,
  readRepositoryUrls,
  readStringList,
  type KanbanMapperResult,
  type KanbanMappingContext
} from './task-dto-validation'

export type { KanbanMapperResult } from './task-dto-validation'
export type { KanbanMappingContext } from './task-dto-validation'

function invalid<T>(): KanbanMapperResult<T> {
  return { ok: false, reason: 'invalid_response' }
}

function ok<T>(value: T): KanbanMapperResult<T> {
  return { ok: true, value }
}

function mapTaskToDetails(raw: unknown, context: KanbanMappingContext): KanbanTaskDetails | null {
  if (!isRecord(raw)) {
    return null
  }
  const id = nonEmptyString(raw.id)
  const title = nonEmptyString(raw.t)
  if (!id || !title) {
    return null
  }
  const lane = mapLane(raw.lane, context.lanesById)
  if (!lane) {
    return null
  }
  if (typeof raw.task_version !== 'number' || !Number.isFinite(raw.task_version)) {
    return null
  }
  const taskVersion = raw.task_version

  const executors = mapPersonList(raw.executors, context.usersById)
  const observers = mapPersonList(raw.observers, context.usersById)
  if (executors === BROKEN || observers === BROKEN) {
    return null
  }
  const createdBy = mapNullablePerson(raw.created_by, context.usersById, true)
  if (createdBy === BROKEN) {
    return null
  }
  const due = readNullableString(raw.due)
  if (due === BROKEN) {
    return null
  }
  const hot = readOptionalBoolean(raw.hot)
  if (hot === BROKEN) {
    return null
  }
  const result = readNullableString(raw.result)
  if (result === BROKEN) {
    return null
  }
  const description = readNullableString(raw.d)
  if (description === BROKEN) {
    return null
  }
  const tags = readStringList(raw.tag)
  if (tags === BROKEN) {
    return null
  }
  const source = readNullableString(raw.src)
  if (source === BROKEN) {
    return null
  }
  const repositoryUrls = readRepositoryUrls(raw.repo, raw.gh)
  if (repositoryUrls === BROKEN) {
    return null
  }
  const blockedBy = readStringList(raw.blocked_by)
  if (blockedBy === BROKEN) {
    return null
  }
  const attachments = mapList(raw.attachments, (item) => mapAttachment(item, id))
  if (attachments === BROKEN) {
    return null
  }
  const subtasks = mapList(raw.subtasks, (item) => mapSubtask(item, context.usersById))
  if (subtasks === BROKEN) {
    return null
  }
  const comments = mapList(raw.c, (item) => mapComment(item, context.usersById))
  if (comments === BROKEN) {
    return null
  }

  return {
    id,
    title,
    laneId: lane.id,
    laneName: lane.name,
    due,
    urgent: hot,
    repositoryUrls,
    taskVersion,
    executors,
    observers,
    createdBy,
    url: `${KANBAN_SERVER_URL}/?task=${encodeURIComponent(id)}`,
    result: result ?? '',
    description: description ?? '',
    tags,
    source,
    comments,
    blockedBy,
    attachments,
    subtasks
  }
}

function toSummary(details: KanbanTaskDetails): KanbanTaskSummary {
  return {
    id: details.id,
    title: details.title,
    laneId: details.laneId,
    laneName: details.laneName,
    due: details.due,
    urgent: details.urgent,
    repositoryUrls: details.repositoryUrls,
    taskVersion: details.taskVersion,
    executors: details.executors,
    observers: details.observers,
    createdBy: details.createdBy,
    url: details.url
  }
}

export function mapKanbanViewer(raw: unknown): KanbanMapperResult<KanbanViewer> {
  if (!isRecord(raw)) {
    return invalid()
  }
  const viewer = raw.user === undefined ? raw : raw.user
  if (!isRecord(viewer)) {
    return invalid()
  }
  const id = nonEmptyString(viewer.user_id) ?? nonEmptyString(viewer.id)
  const name = nonEmptyString(viewer.name)
  const level =
    typeof viewer.level === 'string'
      ? viewer.level
      : typeof viewer.platform_role === 'string'
        ? viewer.platform_role
        : null
  if (!id || !name || level === null) {
    return invalid()
  }
  return ok({ id, name, level })
}

export function mapKanbanTaskList(raw: unknown): KanbanMapperResult<{
  tasks: KanbanTaskSummary[]
  lanes: KanbanLane[]
  context: KanbanMappingContext
}> {
  if (!isRecord(raw)) {
    return invalid()
  }
  if (
    (raw.schema !== undefined &&
      typeof raw.schema !== 'string' &&
      (typeof raw.schema !== 'number' || !Number.isFinite(raw.schema))) ||
    (raw.version !== undefined &&
      (typeof raw.version !== 'number' || !Number.isFinite(raw.version)))
  ) {
    return invalid()
  }
  const lanesRaw = raw.lanes
  if (lanesRaw !== undefined && !Array.isArray(lanesRaw)) {
    return invalid()
  }
  const lanes: KanbanLane[] = []
  const lanesById = new Map<string, KanbanLane>()
  if (Array.isArray(lanesRaw)) {
    for (const item of lanesRaw) {
      const lane = mapLaneObject(item)
      if (!lane) {
        return invalid()
      }
      lanes.push(lane)
      lanesById.set(lane.id, lane)
    }
  }
  const usersById = new Map<string, { id: string; name: string }>()
  if (raw.users !== undefined) {
    if (!Array.isArray(raw.users)) {
      return invalid()
    }
    for (const item of raw.users) {
      if (!isRecord(item)) {
        return invalid()
      }
      const id = nonEmptyString(item.id)
      const name = nonEmptyString(item.name)
      if (!id || !name || usersById.has(id)) {
        return invalid()
      }
      usersById.set(id, { id, name })
    }
  }
  const context = { lanesById, usersById }
  if (!Array.isArray(raw.tasks)) {
    return invalid()
  }
  const tasks: KanbanTaskSummary[] = []
  for (const item of raw.tasks) {
    const details = mapTaskToDetails(item, context)
    if (!details) {
      return invalid()
    }
    tasks.push(toSummary(details))
  }
  return ok({ tasks, lanes, context })
}

export function mapKanbanTaskDetails(
  raw: unknown,
  context: KanbanMappingContext = { lanesById: new Map(), usersById: new Map() }
): KanbanMapperResult<KanbanTaskDetails> {
  if (!isRecord(raw)) {
    return invalid()
  }
  const task = raw.task === undefined ? raw : raw.task
  const details = mapTaskToDetails(task, context)
  return details ? ok(details) : invalid()
}
