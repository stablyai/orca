import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const handlers = new Map<string, (_event: unknown, args?: unknown) => unknown>()
const { listRuntimesMock, recipeContextMock } = vi.hoisted(() => ({
  listRuntimesMock: vi.fn(),
  recipeContextMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/orca-user-data' },
  ipcMain: {
    handle: (channel: string, handler: never) => handlers.set(channel, handler),
    removeHandler: vi.fn()
  }
}))
vi.mock('../../shared/ephemeral-vm-runtime-store', () => ({
  listEphemeralVmRuntimes: listRuntimesMock
}))
vi.mock('./ephemeral-vm-recipe-context', () => ({
  getRuntimeRecipeContext: recipeContextMock
}))

import { registerRecipeForwardedEnvHandler } from './ephemeral-vm-forwarded-env'
import type { RecipeForwardedEnvSummary } from '../../shared/ephemeral-vm-recipe-forwarded-env'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler hands the store to the mocked recipe context only
const store = {} as never

function summarize(args?: unknown): RecipeForwardedEnvSummary {
  const handler = handlers.get('ephemeralVm:forwardedEnvSummary')
  if (!handler) {
    throw new Error('handler not registered')
  }
  return handler({}, args) as RecipeForwardedEnvSummary
}

beforeEach(() => {
  vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'aws-secret')
  vi.stubEnv('OPENAI_API_KEY', 'sk-openai')
  listRuntimesMock.mockReturnValue([
    { id: 'runtime-1', recipeId: 'aws', runtimeEnvironmentId: 'env-recipe' }
  ])
  recipeContextMock.mockReturnValue({ recipe: { id: 'aws', passEnv: ['AWS_*'] } })
  registerRecipeForwardedEnvHandler(store)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
  handlers.clear()
})

it("applies the recipe's own passEnv, looked up from the host's runtime", () => {
  const summary = summarize({ environmentId: 'env-recipe' })
  expect(recipeContextMock).toHaveBeenCalledWith(store, '/tmp/orca-user-data', 'runtime-1')
  expect(summary.narrowed).toBe(true)
  expect(summary.keyLike).toContain('AWS_SECRET_ACCESS_KEY')
  expect(summary.keyLike).not.toContain('OPENAI_API_KEY')
})

it('ignores a passEnv sent from the renderer', () => {
  const summary = summarize({ environmentId: 'env-recipe', passEnv: ['OPENAI_*'] })
  expect(summary.keyLike).toContain('AWS_SECRET_ACCESS_KEY')
  expect(summary.keyLike).not.toContain('OPENAI_API_KEY')

  const withoutHost = summarize({ passEnv: ['AWS_*'] })
  expect(withoutHost.narrowed).toBe(false)
  expect(withoutHost.keyLike).toContain('OPENAI_API_KEY')
})

it('falls back to the whole env for an unknown host or an unresolvable recipe', () => {
  const unknown = summarize({ environmentId: 'env-missing' })
  expect(recipeContextMock).not.toHaveBeenCalled()
  expect(unknown.narrowed).toBe(false)
  expect(unknown.keyLike).toEqual(
    expect.arrayContaining(['AWS_SECRET_ACCESS_KEY', 'OPENAI_API_KEY'])
  )

  recipeContextMock.mockImplementation(() => {
    throw new Error('recipe not found')
  })
  const unresolved = summarize({ environmentId: 'env-recipe' })
  expect(unresolved.narrowed).toBe(false)
  expect(unresolved.keyLike).toContain('OPENAI_API_KEY')
})

it('summarizes the whole env when the recipe sets no passEnv', () => {
  recipeContextMock.mockReturnValue({ recipe: { id: 'aws' } })
  const summary = summarize({ environmentId: 'env-recipe' })
  expect(summary.narrowed).toBe(false)
  expect(summary.keyLike).toEqual(
    expect.arrayContaining(['AWS_SECRET_ACCESS_KEY', 'OPENAI_API_KEY'])
  )
})
