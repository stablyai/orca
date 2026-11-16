// Only a workspace that ever changed hands runs without its owner's personal secrets.
// Workspaces are never shared, so the stored `visibility` column no longer matters.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { START_COMMAND } from '../src/sandbox-vm-commands'
import { ownersForSandbox } from '../src/secrets'
import { createHarness } from './harness'

const KEK = Buffer.alloc(32, 7).toString('base64')
// Fake values only.
const TEAM_KEY = 'sk-ant-api03-TEAM-fake-0000-aaaa'
const PERSONAL_OPENAI = 'sk-proj-fake-personal-openai-2222'
const PERSONAL_VALUES = [PERSONAL_OPENAI, 'personal-db-password', 'personal-foo-value', 'personal-aws-secret-value']

type Harness = Awaited<ReturnType<typeof createHarness>>

const logs: string[] = []
beforeEach(() => {
  logs.length = 0
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '))
    })
  }
})
afterEach(() => {
  for (const value of [...PERSONAL_VALUES, TEAM_KEY]) {
    expect(logs.join('\n')).not.toContain(value)
  }
  vi.restoreAllMocks()
})

function decodeEnv(encoded: string | undefined): Record<string, string> {
  return Object.fromEntries(
    (encoded ?? '')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const at = line.indexOf('=')
        return [line.slice(0, at), Buffer.from(line.slice(at + 1), 'base64').toString('utf8')]
      })
  )
}

/** The env the VM got at its last boot, or from its last live refresh. */
function vmEnv(h: Harness, command: string = START_COMMAND): Record<string, string> {
  return decodeEnv(h.vercel.commands.filter((c) => c.command === command).at(-1)!.env.ORCA_SECRET_ENV)
}

async function seeded(overrides: Record<string, string> = {}, deps: Parameters<typeof createHarness>[1] = {}) {
  const h = await createHarness({ SECRETS_KEK: KEK, ...overrides }, deps)
  const admin = await h.token('ada', 'acme', 'sandbox', { orgRole: 'admin' })
  const mia = await h.token('mia', 'acme', 'sandbox', { orgRole: 'member' })
  const put = (scope: string, name: string, value: string, bearer: string, repo?: string) =>
    h.call('PUT', `/v1/secrets/${scope}/${name}${repo ? `?repo=${encodeURIComponent(repo)}` : ''}`, { body: { value }, bearer })
  await put('org', 'ANTHROPIC_API_KEY', TEAM_KEY, admin)
  await put('org', 'FOO', 'team-foo-value', admin)
  await put('repo', 'BAR', 'repo-bar-value', admin, 'acme/app')
  await put('personal', 'OPENAI_API_KEY', PERSONAL_OPENAI, mia)
  await put('personal', 'DB_PASSWORD', 'personal-db-password', mia)
  await put('personal', 'FOO', 'personal-foo-value', mia)
  await put('personal', 'AWS_SECRET_ACCESS_KEY', 'personal-aws-secret-value', mia)
  const create = (visibility?: 'team' | 'private') =>
    h.call('POST', '/v1/sandboxes', {
      body: { workspaceId: 'ws-1', machineSize: 'standard', repo: { url: 'https://github.com/acme/app' }, ...(visibility ? { visibility } : {}) },
      bearer: mia
    })
  return { h, mia, admin, put, create }
}

const TEAM_AND_REPO = { ANTHROPIC_API_KEY: TEAM_KEY, BAR: 'repo-bar-value', FOO: 'team-foo-value' }

describe('personal secrets', () => {
  it('a transferred workspace gets no personal owner, for good; visibility is ignored', () => {
    const row = { account_id: 'org:acme', user_id: 'mia', repo_url: 'https://github.com/acme/app', ownership_transferred_at: null }
    expect(ownersForSandbox(row).personal).toBe('user:mia')
    expect(ownersForSandbox({ ...row, visibility: 'team' } as typeof row).personal).toBe('user:mia')
    expect(ownersForSandbox({ ...row, ownership_transferred_at: 20 })).toEqual({ org: 'org:acme', personal: null, repo: 'org:acme#github.com/acme/app' })
  })

  it('keeps the owner’s personal secrets in their own private workspace', async () => {
    const { h, create } = await seeded()
    expect((await create()).status).toBe(200)
    expect(vmEnv(h)).toEqual({
      ...TEAM_AND_REPO,
      AWS_SECRET_ACCESS_KEY: 'personal-aws-secret-value',
      DB_PASSWORD: 'personal-db-password',
      FOO: 'personal-foo-value',
      OPENAI_API_KEY: PERSONAL_OPENAI
    })
  })

  it('a create that asks for team, or a row still stored as team, is the owner’s alone: their personal secrets apply', async () => {
    const { h, create, mia } = await seeded()
    const id: string = (await create('team')).body.sandbox.id
    expect(vmEnv(h).DB_PASSWORD).toBe('personal-db-password')
    h.raw.prepare("UPDATE sandboxes SET visibility = 'team' WHERE id = ?").run(id)
    await h.call('POST', `/v1/sandboxes/${id}/suspend`, { bearer: mia })
    await h.call('POST', `/v1/sandboxes/${id}/resume`, { bearer: mia })
    expect(vmEnv(h)).toMatchObject({ DB_PASSWORD: 'personal-db-password', OPENAI_API_KEY: PERSONAL_OPENAI })
  })
})
