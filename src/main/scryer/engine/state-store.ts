/* eslint-disable max-lines -- Why: state-store is the durable transaction boundary for .scryer IO, locks, compatibility checks, commits, and maintenance warnings. */
import { mkdir, open, readFile, rename, rm, unlink, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { SCRY_VERSION, type ScryModel } from './model'
import { scryModelSchema } from './schemas'
import { scryerPaths, type ScryerPaths } from './paths'
import { ScryerEngineError } from './engine-error'
import type {
  ModelEditLease,
  ResolvedScryerProject,
  ScryerFlatOperationPolicy,
  ScryerLoadedState,
  ScryerOperationId,
  ScryerOperationWarning,
  ScryerSyncState
} from './types'

export type { ModelEditLease } from './types'

type FailureInjection = {
  failPrimaryTarget?: 'planned' | 'committed' | 'sync' | 'anchor_baseline'
  failBestEffortTarget?:
    | 'history'
    | 'baseline'
    | 'sync'
    | 'anchor_baseline'
    | 'committed_source_map_reanchor'
}

export type ScryerPrimaryCommitItem =
  | { target: 'planned'; model: ScryModel }
  | { target: 'committed'; model: ScryModel }
  | { target: 'sync'; state: ScryerSyncState }
  | { target: 'anchor_baseline'; action: 'refresh' }

export type ScryerBestEffortCommitItem =
  | { target: 'history'; events: Record<string, unknown>[] }
  | { target: 'baseline'; action: 'refresh' }
  | { target: 'sync'; state: ScryerSyncState }
  | { target: 'anchor_baseline'; action: 'refresh' }
  | { target: 'committed_source_map_reanchor'; action: 'refresh' }

export type ScryerStateCommitPlan = {
  operationId: ScryerOperationId
  requestId: string
  project: ResolvedScryerProject
  primary: ScryerPrimaryCommitItem[]
  bestEffort: ScryerBestEffortCommitItem[]
}

export type ScryerStateCommitResult = {
  warnings: ScryerOperationWarning[]
}

export type ScryerStateStore = {
  paths(projectRoot: string): ScryerPaths
  resolveProject(projectRoot: string): ResolvedScryerProject
  loadDeclaredState(
    project: ResolvedScryerProject,
    policy: ScryerFlatOperationPolicy
  ): Promise<ScryerLoadedState>
  commit(plan: ScryerStateCommitPlan): Promise<ScryerStateCommitResult>
  readCommitted(projectRoot: string): Promise<ScryModel>
  readPlanned(projectRoot: string): Promise<ScryModel>
  readPlannedForEdit(projectRoot: string): Promise<ScryModel>
  readActiveLease(projectRoot: string): Promise<ModelEditLease | null>
  withWriteLock<T>(projectRoot: string, action: () => Promise<T>): Promise<T>
}

function serializeModel(model: ScryModel): string {
  return `${JSON.stringify(model, null, 2)}\n`
}

function ioDetails(
  target: string,
  operation: 'read' | 'write' | 'rename' | 'mkdir' | 'append' | 'lock',
  path: string,
  error?: unknown
): Record<string, unknown> {
  return {
    target,
    operation,
    path,
    ...(error ? { cause: error instanceof Error ? error.message : String(error) } : {})
  }
}

function parseModel(raw: string, filePath: string): ScryModel {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (error) {
    throw new ScryerEngineError(
      'incompatible_model',
      `Failed to parse Scryer model at ${filePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { path: filePath, expectedVersion: SCRY_VERSION, reason: 'invalid_json' }
    )
  }
  if (typeof value !== 'object' || value === null) {
    throw new ScryerEngineError(
      'incompatible_model',
      `Scryer model at ${filePath} is not an object`,
      {
        path: filePath,
        expectedVersion: SCRY_VERSION,
        reason: 'invalid_json'
      }
    )
  }
  const record = value as Record<string, unknown>
  const version = typeof record.version === 'string' ? record.version : undefined
  if (version !== SCRY_VERSION) {
    throw new ScryerEngineError(
      'incompatible_model',
      `Model file uses schema version '${version ?? '<missing>'}', but this engine requires '${SCRY_VERSION}'.`,
      {
        path: filePath,
        expectedVersion: SCRY_VERSION,
        actualVersion: version,
        reason: version ? 'unsupported_version' : 'missing_version'
      }
    )
  }
  const parsed = scryModelSchema.safeParse(record)
  if (!parsed.success) {
    const fieldErrors = fieldErrorsFromZod(parsed.error)
    throw new ScryerEngineError(
      'incompatible_model',
      `Scryer model at ${filePath} failed schema validation`,
      {
        path: filePath,
        expectedVersion: SCRY_VERSION,
        reason: hasUnrecognizedKeys(parsed.error) ? 'unknown_fields' : 'invalid_schema',
        fields: fieldErrors.map((error) => error.path)
      },
      false,
      fieldErrors
    )
  }
  return parsed.data
}

function plannedSeedFromCommitted(committed: ScryModel): ScryModel {
  return {
    ...JSON.parse(JSON.stringify(committed)),
    sourceMap: {},
    boundaries: {}
  } as ScryModel
}

function formatZodPath(path: unknown[], key?: string): string {
  const base = path
    .map((part) => (typeof part === 'number' ? `[${part}]` : String(part)))
    .join('.')
    .replaceAll('.[', '[')
  return key ? (base ? `${base}.${key}` : key) : base || 'input'
}

function fieldErrorsFromZod(error: {
  issues?: unknown
}): { path: string; message: string; code?: string }[] {
  const issues = Array.isArray(error.issues)
    ? (error.issues as { path?: unknown[]; message?: string; code?: string; keys?: string[] }[])
    : []
  return issues.flatMap((issue) => {
    if (issue.code === 'unrecognized_keys' && Array.isArray(issue.keys)) {
      return issue.keys.map((key) => ({
        path: formatZodPath(issue.path ?? [], key),
        message: issue.message ?? 'Unrecognized key',
        code: issue.code
      }))
    }
    return [
      {
        path: formatZodPath(issue.path ?? []),
        message: issue.message ?? 'Invalid value',
        ...(issue.code ? { code: issue.code } : {})
      }
    ]
  })
}

function hasUnrecognizedKeys(error: { issues?: unknown }): boolean {
  return Array.isArray(error.issues)
    ? (error.issues as { code?: string }[]).some((issue) => issue.code === 'unrecognized_keys')
    : false
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  const tmpPath = join(
    dirname(filePath),
    `.tmp.${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  )
  await writeFile(tmpPath, content, 'utf8')
  await rename(tmpPath, filePath)
}

async function readOptionalRaw(path: string): Promise<string | null> {
  if (!existsSync(path)) {
    return null
  }
  return readFile(path, 'utf8')
}

async function restoreRaw(path: string, raw: string | null): Promise<void> {
  if (raw === null) {
    await rm(path, { force: true })
    return
  }
  await atomicWrite(path, raw)
}

function targetPath(paths: ScryerPaths, target: ScryerPrimaryCommitItem['target']): string {
  switch (target) {
    case 'planned':
      return paths.plannedPath
    case 'committed':
      return paths.modelPath
    case 'sync':
      return paths.syncPath
    case 'anchor_baseline':
      return paths.anchorBaselinePath
  }
}

async function writePrimary(
  paths: ScryerPaths,
  item: ScryerPrimaryCommitItem,
  failureInjection?: FailureInjection
): Promise<void> {
  if (failureInjection?.failPrimaryTarget === item.target) {
    throw new Error(`Injected primary write failure for ${item.target}`)
  }
  switch (item.target) {
    case 'planned':
      await atomicWrite(paths.plannedPath, serializeModel(item.model))
      break
    case 'committed':
      await atomicWrite(paths.modelPath, serializeModel(item.model))
      break
    case 'sync':
      await atomicWrite(paths.syncPath, `${JSON.stringify(item.state, null, 2)}\n`)
      break
    case 'anchor_baseline':
      await atomicWrite(
        paths.anchorBaselinePath,
        `${JSON.stringify({ refreshedAt: Date.now() })}\n`
      )
      break
  }
}

async function writeBestEffort(
  paths: ScryerPaths,
  item: ScryerBestEffortCommitItem,
  committed: ScryModel | undefined,
  failureInjection?: FailureInjection
): Promise<void> {
  if (failureInjection?.failBestEffortTarget === item.target) {
    throw new Error(`Injected best-effort write failure for ${item.target}`)
  }
  switch (item.target) {
    case 'history':
      await mkdir(dirname(paths.historyPath), { recursive: true })
      await writeFile(
        paths.historyPath,
        `${item.events.map((event) => JSON.stringify(event)).join('\n')}\n`,
        { encoding: 'utf8', flag: 'a' }
      )
      break
    case 'baseline':
      if (committed) {
        await atomicWrite(paths.baselinePath, serializeModel(committed))
      }
      break
    case 'sync':
      await atomicWrite(paths.syncPath, `${JSON.stringify(item.state, null, 2)}\n`)
      break
    case 'anchor_baseline':
      await atomicWrite(
        paths.anchorBaselinePath,
        `${JSON.stringify({ refreshedAt: Date.now() })}\n`
      )
      break
    case 'committed_source_map_reanchor':
      if (committed) {
        await atomicWrite(paths.modelPath, serializeModel(committed))
      }
      break
  }
}

export function createScryerStateStore(
  options: { test?: FailureInjection } = {}
): ScryerStateStore {
  async function readModelFile(path: string, target: 'model' | 'planned'): Promise<ScryModel> {
    if (!existsSync(path)) {
      throw new ScryerEngineError(
        'incompatible_model',
        `Missing Scryer ${target} file at ${path}`,
        {
          path,
          expectedVersion: SCRY_VERSION,
          reason: 'invalid_json'
        }
      )
    }
    try {
      return parseModel(await readFile(path, 'utf8'), path)
    } catch (error) {
      if (error instanceof ScryerEngineError) {
        throw error
      }
      throw new ScryerEngineError(
        'io_error',
        `Failed to read Scryer ${target} file`,
        ioDetails(target, 'read', path, error)
      )
    }
  }

  return {
    paths: scryerPaths,
    resolveProject(projectRoot) {
      return { projectRoot: resolve(projectRoot) }
    },
    async readCommitted(projectRoot) {
      const paths = scryerPaths(projectRoot)
      return readModelFile(paths.modelPath, 'model')
    },
    async readPlanned(projectRoot) {
      const paths = scryerPaths(projectRoot)
      if (!existsSync(paths.plannedPath)) {
        return this.readCommitted(projectRoot)
      }
      return readModelFile(paths.plannedPath, 'planned')
    },
    async readPlannedForEdit(projectRoot) {
      const paths = scryerPaths(projectRoot)
      if (existsSync(paths.plannedPath)) {
        return readModelFile(paths.plannedPath, 'planned')
      }
      if (!existsSync(paths.modelPath)) {
        return {
          version: SCRY_VERSION,
          nodes: [],
          links: [],
          groups: [],
          sourceMap: {},
          boundaries: {}
        }
      }
      return plannedSeedFromCommitted(await this.readCommitted(projectRoot))
    },
    async loadDeclaredState(project, policy) {
      const loaded: ScryerLoadedState = {}
      if (policy.reads.includes('committed')) {
        loaded.committed = await this.readCommitted(project.projectRoot)
      }
      if (policy.reads.includes('committed_if_available')) {
        const paths = scryerPaths(project.projectRoot)
        if (existsSync(paths.modelPath)) {
          loaded.committed = await this.readCommitted(project.projectRoot)
        }
      }
      if (policy.reads.includes('planned')) {
        loaded.planned = policy.semanticWrites.includes('planned')
          ? await this.readPlannedForEdit(project.projectRoot)
          : await this.readPlanned(project.projectRoot)
        if (!loaded.committed && policy.reads.includes('committed')) {
          loaded.committed = await this.readCommitted(project.projectRoot)
        }
      }
      return loaded
    },
    async commit(plan) {
      const paths = scryerPaths(plan.project.projectRoot)
      const backups = new Map<string, string | null>()
      const committed = plan.primary.find((item) => item.target === 'committed') as
        | { target: 'committed'; model: ScryModel }
        | undefined
      try {
        for (const item of plan.primary) {
          const path = targetPath(paths, item.target)
          if (!backups.has(path)) {
            backups.set(path, await readOptionalRaw(path))
          }
          await writePrimary(paths, item, options.test)
        }
      } catch (error) {
        for (const [path, raw] of [...backups].reverse()) {
          await restoreRaw(path, raw).catch(() => undefined)
        }
        throw new ScryerEngineError(
          'io_error',
          `Failed to commit Scryer state for ${plan.operationId}`,
          ioDetails('model', 'write', paths.scryerDir, error)
        )
      }

      const warnings: ScryerOperationWarning[] = []
      const committedModel =
        committed?.model ??
        (existsSync(paths.modelPath)
          ? await this.readCommitted(plan.project.projectRoot)
          : undefined)
      for (const item of plan.bestEffort) {
        try {
          await writeBestEffort(paths, item, committedModel, options.test)
        } catch (error) {
          warnings.push({
            code: 'maintenance_write_failed',
            message: `Best-effort Scryer maintenance write failed for ${item.target}`,
            target: item.target,
            details: { cause: error instanceof Error ? error.message : String(error) }
          })
        }
      }
      return { warnings }
    },
    async readActiveLease(projectRoot) {
      const paths = scryerPaths(projectRoot)
      if (!existsSync(paths.leasePath)) {
        return null
      }
      const raw = await readFile(paths.leasePath, 'utf8')
      let value: unknown
      try {
        value = JSON.parse(raw)
      } catch {
        throw new ScryerEngineError('lease_required', 'Scryer model edit lease is unreadable', {
          policy: 'write_if_active'
        })
      }
      if (typeof value !== 'object' || value === null) {
        throw new ScryerEngineError('lease_required', 'Scryer model edit lease is invalid', {
          policy: 'write_if_active'
        })
      }
      const record = value as Record<string, unknown>
      if (typeof record.token !== 'string' || record.token.length === 0) {
        throw new ScryerEngineError('lease_required', 'Scryer model edit lease has no token', {
          policy: 'write_if_active'
        })
      }
      return {
        token: record.token,
        ...(record.owner === 'agent' || record.owner === 'human' || record.owner === 'system'
          ? { owner: record.owner }
          : {}),
        ...(typeof record.agentRunId === 'string' ? { agentRunId: record.agentRunId } : {})
      }
    },
    async withWriteLock(projectRoot, action) {
      const paths = scryerPaths(projectRoot)
      await mkdir(paths.scryerDir, { recursive: true })
      let handle: Awaited<ReturnType<typeof open>> | null = null
      try {
        handle = await open(paths.lockPath, 'wx')
      } catch (error) {
        const code =
          typeof error === 'object' && error !== null ? (error as { code?: string }).code : ''
        if (code === 'EEXIST') {
          throw new ScryerEngineError(
            'lock_busy',
            `Scryer model lock is already held at ${paths.lockPath}`,
            { lockPath: paths.lockPath },
            true
          )
        }
        throw new ScryerEngineError(
          'io_error',
          'Failed to acquire Scryer model lock',
          ioDetails('lock', 'lock', paths.lockPath, error)
        )
      }
      try {
        await handle.writeFile(`${process.pid}\n`, 'utf8')
        return await action()
      } finally {
        await handle.close()
        await unlink(paths.lockPath).catch(() => undefined)
      }
    }
  }
}
