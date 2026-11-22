import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  gitlabWebhookFilters,
  type GitLabEventRule
} from '../../../shared/automation-gitlab-triggers'
import type { Automation } from '../../../shared/automations/automation-definition'
import { GitLabEventHooks, GitLabEventHookStore } from './gitlab-event-hooks'
import type { GitLabProjectHook } from './gitlab-project-hooks'

const HOOK = 'wh_AAAAAAAAAAAAAAAA'

function automationFor(rule: GitLabEventRule): Automation {
  const trigger = {
    id: `wh-${HOOK}`,
    source: 'webhook',
    event: 'call',
    rev: 1,
    ...gitlabWebhookFilters(rule)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fields the upkeep reads.
  return {
    id: 'a-1',
    name: 'Mentions',
    enabled: true,
    bot: { botId: 'bot-1' },
    on: [trigger]
  } as unknown as Automation
}

function setUp(rule: GitLabEventRule) {
  const automations = [automationFor(rule)]
  let keyGeneration = 1
  const hooks = new Map<string, GitLabProjectHook>()
  let nextId = 100
  const gitlab = {
    create: vi.fn(async (_host: string | undefined, project: string, hook: GitLabProjectHook) => {
      hooks.set(project, hook)
      return nextId++
    }),
    update: vi.fn(
      async (_host: string | undefined, project: string, _id: number, hook: GitLabProjectHook) => {
        hooks.set(project, hook)
      }
    ),
    remove: vi.fn(async (_host: string | undefined, project: string) => {
      hooks.delete(project)
    })
  }
  const host = {
    automations: () => automations,
    keyGeneration: async () => keyGeneration,
    url: async () => `https://hooks.example/hooks/${HOOK}/key-${keyGeneration}`,
    setSecret: vi.fn(async (_hookId: string, _secret: string) => undefined),
    tell: vi.fn()
  }
  const store = new GitLabEventHookStore(
    join(mkdtempSync(join(tmpdir(), 'gitlab-events-')), 'hooks.json')
  )
  const saved = new Map<string, string>()
  const secrets = {
    read: async (hookId: string) => saved.get(hookId) ?? null,
    save: async (hookId: string, secret: string) => {
      saved.set(hookId, secret)
    },
    clear: vi.fn(async (hookId: string) => {
      saved.delete(hookId)
    })
  }
  return {
    upkeep: new GitLabEventHooks(host, gitlab, store, secrets),
    gitlab,
    host,
    hooks,
    automations,
    saved,
    secrets,
    rotate: () => {
      keyGeneration += 1
    }
  }
}

const mentions: GitLabEventRule = {
  event: 'comment',
  projects: ['acme/api', 'acme/web'],
  contains: '@scout'
}

describe('GitLabEventHooks', () => {
  it('signs a webhook on each project with the secret the Orca hook takes, once', async () => {
    const { upkeep, gitlab, host, hooks } = setUp(mentions)
    await upkeep.reconcile()
    await upkeep.reconcile()

    expect(gitlab.create).toHaveBeenCalledTimes(2)
    expect(host.setSecret).toHaveBeenCalledTimes(1)
    const secret = host.setSecret.mock.calls[0][1]
    expect(secret).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/)
    expect([...hooks.values()].map((hook) => [hook.url, hook.signingToken, hook.flag])).toEqual([
      [`https://hooks.example/hooks/${HOOK}/key-1`, secret, 'note_events'],
      [`https://hooks.example/hooks/${HOOK}/key-1`, secret, 'note_events']
    ])
  })

  it('points every webhook at the new URL after the key rotates, on the same secret', async () => {
    const { upkeep, gitlab, host, hooks, rotate } = setUp(mentions)
    await upkeep.reconcile()
    rotate()
    await upkeep.reconcile()

    expect(gitlab.update).toHaveBeenCalledTimes(2)
    expect(host.setSecret).toHaveBeenCalledTimes(1)
    const secret = host.setSecret.mock.calls[0][1]
    expect([...hooks.values()].map((hook) => [hook.url, hook.signingToken])).toEqual([
      [`https://hooks.example/hooks/${HOOK}/key-2`, secret],
      [`https://hooks.example/hooks/${HOOK}/key-2`, secret]
    ])
  })

  it('leaves a project whose update GitLab refuses on the secret the hook still checks', async () => {
    const { upkeep, gitlab, host, hooks, rotate } = setUp(mentions)
    await upkeep.reconcile()
    rotate()
    gitlab.update.mockImplementationOnce(async (_host, project, _id, hook) => {
      hooks.set(project, hook)
    })
    gitlab.update.mockRejectedValueOnce(new Error('GitLab couldn’t save the webhook on acme/web'))
    await upkeep.reconcile()

    expect(host.setSecret).toHaveBeenCalledTimes(1)
    const secret = host.setSecret.mock.calls[0][1]
    expect(hooks.get('acme/api')?.signingToken).toBe(secret)
    expect(hooks.get('acme/web')?.signingToken).toBe(secret)
    expect(host.tell).toHaveBeenCalledTimes(1)
  })

  it('removes the webhooks and their secret once the rule is gone, retrying a failed clear', async () => {
    const { upkeep, gitlab, hooks, automations, saved, secrets } = setUp(mentions)
    await upkeep.reconcile()
    automations.length = 0
    secrets.clear.mockRejectedValueOnce(new Error('locked'))
    await upkeep.reconcile()
    expect(hooks.size).toBe(0)
    expect(saved.size).toBe(1)

    await upkeep.reconcile()
    expect(gitlab.remove).toHaveBeenCalledTimes(2)
    expect(saved.size).toBe(0)
  })

  it('keeps the projects GitLab accepted signed when another refuses, and tells the bot once', async () => {
    const { upkeep, gitlab, host, hooks } = setUp(mentions)
    const refused = new Error('GitLab refused a webhook on acme/web')
    gitlab.create.mockImplementationOnce(async (_host, project, hook) => {
      hooks.set(project, hook)
      return 100
    })
    gitlab.create.mockRejectedValueOnce(refused)
    await upkeep.reconcile()
    gitlab.create.mockRejectedValueOnce(refused)
    await upkeep.reconcile()

    expect(gitlab.update).toHaveBeenCalledWith(undefined, 'acme/api', 100, expect.anything())
    expect(host.setSecret).toHaveBeenCalledTimes(1)
    expect(hooks.get('acme/api')?.signingToken).toBe(host.setSecret.mock.calls[0][1])
    expect(host.tell).toHaveBeenCalledTimes(1)
    expect(host.tell).toHaveBeenCalledWith(
      'bot-1',
      '“Mentions”: GitLab refused a webhook on acme/web'
    )
  })
})
