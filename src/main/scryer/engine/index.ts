import { randomUUID } from 'crypto'
import { createDefaultScryerOperationCatalog } from './catalog'
import { createScryerErrorMapper } from './error-mapper'
import { executeCatalogOperation } from './pipeline'
import { createScryerStateStore, type ScryerStateStore } from './state-store'
import type {
  CreateScryerEngineOptions,
  ScryerOperationContext,
  ScryerOperationId,
  ScryerOperationResult,
  ScryerReadView,
  ScryerReadViewInput
} from './types'

export type ScryerEngine = {
  executeOperation<T = unknown>(
    id: ScryerOperationId | string,
    input: unknown,
    context: ScryerOperationContext
  ): Promise<ScryerOperationResult<T>>
  readView(
    input: ScryerReadViewInput,
    context: ScryerOperationContext
  ): Promise<ScryerOperationResult<ScryerReadView>>
}

function defaultClock() {
  return {
    nowIso() {
      return new Date().toISOString()
    }
  }
}

function defaultRequestIds() {
  return {
    next() {
      return `scryer-${randomUUID()}`
    }
  }
}

export function createScryerEngine(options: CreateScryerEngineOptions = {}): ScryerEngine {
  const catalog = options.catalog ?? createDefaultScryerOperationCatalog()
  const validation = catalog.validateCatalog({
    allowTestTransport: options.test?.allowTestTransport ?? false
  })
  if (!validation.ok) {
    throw new Error(
      `Invalid Scryer operation catalog: ${validation.errors
        .map((error) => `${error.operationId ?? '<catalog>'}:${error.code}`)
        .join(', ')}`
    )
  }
  const store = (options.stateStore as ScryerStateStore | undefined) ?? createScryerStateStore()
  const errorMapper = options.errorMapper ?? createScryerErrorMapper()
  const clock = options.clock ?? defaultClock()
  const requestIds = options.requestIds ?? defaultRequestIds()
  return {
    executeOperation<T = unknown>(
      id: ScryerOperationId | string,
      input: unknown,
      context: ScryerOperationContext
    ): Promise<ScryerOperationResult<T>> {
      return executeCatalogOperation(id, input, context, {
        catalog,
        store,
        errorMapper,
        clock,
        requestIds,
        allowTestTransport: options.test?.allowTestTransport ?? false
      }) as Promise<ScryerOperationResult<T>>
    },
    readView(input, context) {
      return this.executeOperation<ScryerReadView>(
        'scryer.model.read',
        input,
        context
      )
    }
  }
}

export async function executeOperation<T = unknown>(
  id: ScryerOperationId | string,
  input: unknown,
  context: ScryerOperationContext
): Promise<ScryerOperationResult<T>> {
  return createScryerEngine().executeOperation<T>(id, input, context)
}

export async function readView(
  input: ScryerReadViewInput,
  context: ScryerOperationContext
): Promise<ScryerOperationResult<ScryerReadView>> {
  return createScryerEngine().readView(input, context)
}

export { createDefaultScryerOperationCatalog, createScryerOperationCatalog } from './catalog'
export { createScryerErrorMapper } from './error-mapper'
export { createScryerStateStore }

export type {
  CreateScryerEngineOptions,
  ModelEditLease,
  PendingSummary,
  ScryerCatalogValidationError,
  ScryerCatalogValidationResult,
  ScryerClock,
  ScryerExecutorResult,
  ScryerLayer,
  ScryerModelReadResult,
  ScryerModelValidateResult,
  ScryerOperationCatalog,
  ScryerOperationContext,
  ScryerOperationContract,
  ScryerOperationError,
  ScryerOperationErrorCode,
  ScryerOperationId,
  ScryerOperationResult,
  ScryerPlanFoldInput,
  ScryerPlanFoldResult,
  ScryerPlanPendingResult,
  ScryerProjectRef,
  ScryerReadView,
  ScryerReadViewInput,
  ScryerRequestIdFactory,
  ScryerValidationFinding
} from './types'
