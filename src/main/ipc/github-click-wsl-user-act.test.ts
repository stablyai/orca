// A click on a cwd-less gh action may start the stopped default distro its gh lives in (E9); the
// same reads from mount effects on a restored page must not.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as WslModule from '../wsl'

const { handlers, getDefaultWslDistroMock, ranAsUserAct } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, args?: unknown) => unknown>(),
  getDefaultWslDistroMock: vi.fn(),
  // Each stub answers whether it ran inside a user act for the default distro.
  ranAsUserAct: async (): Promise<boolean> =>
    (await import('../wsl/wsl-user-act-scope')).isWslUserActFor('Ubuntu')
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, args?: unknown) => unknown) =>
      handlers.set(channel, handler)
  }
}))

vi.mock('../wsl', async (importOriginal) => ({
  ...(await importOriginal<typeof WslModule>()),
  getDefaultWslDistro: getDefaultWslDistroMock
}))

vi.mock('../github/auth-diagnose', () => ({ diagnoseGhAuth: vi.fn(ranAsUserAct) }))

vi.mock('../github/project-view', () => ({
  addIssueCommentBySlug: vi.fn(ranAsUserAct),
  clearProjectItemFieldValue: vi.fn(ranAsUserAct),
  deleteIssueCommentBySlug: vi.fn(ranAsUserAct),
  getProjectViewTable: vi.fn(ranAsUserAct),
  getWorkItemDetailsBySlug: vi.fn(ranAsUserAct),
  listAccessibleProjects: vi.fn(ranAsUserAct),
  listAssignableUsersBySlug: vi.fn(ranAsUserAct),
  listIssueTypesBySlug: vi.fn(ranAsUserAct),
  listLabelsBySlug: vi.fn(ranAsUserAct),
  listProjectViews: vi.fn(ranAsUserAct),
  listReviewTeamsBySlug: vi.fn(ranAsUserAct),
  resolveProjectRef: vi.fn(ranAsUserAct),
  updateIssueBySlug: vi.fn(ranAsUserAct),
  updateIssueCommentBySlug: vi.fn(ranAsUserAct),
  updateIssueTypeBySlug: vi.fn(ranAsUserAct),
  updateProjectItemFieldValue: vi.fn(ranAsUserAct),
  updatePullRequestBySlug: vi.fn(ranAsUserAct)
}))

import { registerGitHubProjectViewHandlers } from './github-project-view-handlers'
import { registerGitHubAccountHandlers } from './github-account-handlers'
import type { Store } from '../persistence'
import type { WakeWslDistroArg } from '../../shared/github/project-request-types'

const originalPlatform = process.platform

beforeEach(() => {
  handlers.clear()
  getDefaultWslDistroMock.mockReset().mockReturnValue('Ubuntu')
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  registerGitHubProjectViewHandlers()
  registerGitHubAccountHandlers(unusedStore())
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
})

function unusedStore(): Store {
  const store: Partial<Store> = {}
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handlers invoked here never read the store.
  return store as Store
}

function invoke(channel: string, args: WakeWslDistroArg = {}): unknown {
  const handler = handlers.get(channel)
  if (!handler) {
    throw new Error(`no handler for ${channel}`)
  }
  return handler({}, args)
}

const CLICK_CHANNELS = [
  'gh:listAccessibleProjects',
  'gh:resolveProjectRef',
  'gh:listProjectViews',
  'gh:projectWorkItemDetailsBySlug',
  'gh:updateProjectItemField',
  'gh:clearProjectItemField',
  'gh:updateIssueBySlug',
  'gh:updatePullRequestBySlug',
  'gh:addIssueCommentBySlug',
  'gh:updateIssueCommentBySlug',
  'gh:deleteIssueCommentBySlug',
  'gh:updateIssueTypeBySlug'
]

describe('cwd-less gh calls run as a user act on the default distro only when a click says so', () => {
  it.each(CLICK_CHANNELS)('%s with wakeWslDistro', async (channel) => {
    await expect(invoke(channel, { wakeWslDistro: true })).resolves.toBe(true)
  })

  // E.g. useProjectViewTable lists a restored board's views from a mount effect, with no click.
  it.each(CLICK_CHANNELS)('%s without it stays gated', async (channel) => {
    await expect(invoke(channel)).resolves.toBe(false)
  })

  it.each([
    'gh:getProjectViewTable',
    'gh:listLabelsBySlug',
    'gh:listAssignableUsersBySlug',
    'gh:listReviewTeamsBySlug',
    'gh:listIssueTypesBySlug'
  ])('%s never wakes, even when asked', async (channel) => {
    await expect(invoke(channel, { wakeWslDistro: true })).resolves.toBe(false)
  })

  // GhAuthErrorHelp diagnoses from a mount effect.
  it('the auth diagnosis never wakes', async () => {
    await expect(invoke('gh:diagnoseAuth', { wakeWslDistro: true })).resolves.toBe(false)
  })
})
