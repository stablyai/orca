import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  list: vi.fn(async () => ({ templates: [], stale: false })),
  get: vi.fn(async (name: string) => ({
    template: { name, filename: `${name}.gitignore` },
    content: '',
    stale: false
  }))
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/test/user-data' },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, handler)
    }
  }
}))

vi.mock('../gitignore/github-gitignore-template-service', () => ({
  GitHubGitignoreTemplateService: class {
    list = mocks.list
    get = mocks.get
  }
}))

vi.mock('../gitignore/gitignore-template-file-cache', () => ({
  GitignoreTemplateFileCache: class {}
}))

vi.mock('../network/http-client', () => ({
  getMainHttpClient: () => ({ fetch: vi.fn() })
}))

import { registerGitignoreTemplateHandlers } from './gitignore-templates'

describe('registerGitignoreTemplateHandlers', () => {
  beforeEach(() => {
    mocks.handlers.clear()
    mocks.list.mockClear()
    mocks.get.mockClear()
  })

  it('registers dedicated list and get channels', () => {
    registerGitignoreTemplateHandlers()
    expect([...mocks.handlers.keys()]).toEqual([
      'gitignore-templates:list',
      'gitignore-templates:get'
    ])
  })

  it('routes requests through the bounded template service', async () => {
    registerGitignoreTemplateHandlers()
    await mocks.handlers.get('gitignore-templates:list')?.({})
    await mocks.handlers.get('gitignore-templates:get')?.({}, 'Node')
    expect(mocks.list).toHaveBeenCalledOnce()
    expect(mocks.get).toHaveBeenCalledWith('Node')
  })
})
