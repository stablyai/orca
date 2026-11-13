// SECRETS-EFFECTIVE-SHARED: the effective view can answer for a workspace shared with the team, which
// gets no personal secrets (SEC-5), so Settings never shows a personal value winning there.
import { describe, expect, it } from 'vitest'
import { createHarness } from './harness'

const KEK = Buffer.alloc(32, 7).toString('base64')

async function setup() {
  const h = await createHarness({ SECRETS_KEK: KEK })
  const admin = await h.token('ada', 'acme', 'sandbox', { org_role: 'admin' })
  const mia = await h.token('mia', 'acme', 'sandbox', { org_role: 'member' })
  const put = (scope: string, name: string, value: string, bearer: string, repo?: string) =>
    h.call('PUT', `/v1/secrets/${scope}/${name}${repo ? `?repo=${encodeURIComponent(repo)}` : ''}`, { body: { value }, bearer })
  await put('org', 'FOO', 'org-foo-value', admin)
  await put('personal', 'FOO', 'personal-foo-value', mia)
  await put('personal', 'ONLY_MINE', 'mine', mia)
  await put('org', 'ANTHROPIC_API_KEY', 'sk-ant-api03-fake-org-0000-aaaa', admin)
  await put('personal', 'ANTHROPIC_API_KEY', 'sk-ant-api03-fake-mine-1111-bbbb', mia)
  await put('repo', 'BAR', 'repo-bar-value', admin, 'acme/app')
  const effective = async (query: string) => (await h.call('GET', `/v1/secrets/effective?${query}`, { bearer: mia })).body
  return { h, mia, effective }
}

const summary = (secrets: { name: string; scope: string; shadowed: { scope: string }[] }[]) =>
  secrets.map((s) => [s.name, s.scope, s.shadowed.map((x) => x.scope)])

describe('effective view for a shared workspace', () => {
  it('drops personal values: no personal winner, nothing personal shadowed, personal-only names gone', async () => {
    const { effective } = await setup()
    const shared = await effective('repo=acme/app&workspace=shared')
    expect(shared.workspace).toBe('shared')
    expect(summary(shared.secrets)).toEqual([
      ['ANTHROPIC_API_KEY', 'org', []],
      ['BAR', 'repo', []],
      ['FOO', 'org', []]
    ])
    // The default (not shared) still shows the personal value winning for env.
    const own = await effective('repo=acme/app')
    expect(own.workspace).toBe('private')
    expect(summary(own.secrets)).toEqual([
      ['ANTHROPIC_API_KEY', 'org', ['personal']],
      ['BAR', 'repo', []],
      ['FOO', 'personal', ['org']],
      ['ONLY_MINE', 'personal', []]
    ])
  })

  it('a personal account’s shared view with no repo is empty, and an unknown mode is refused', async () => {
    const { h } = await setup()
    const solo = await h.token('carol')
    await h.call('PUT', '/v1/secrets/personal/MY_VAR', { body: { value: 'x' }, bearer: solo })
    expect((await h.call('GET', '/v1/secrets/effective?workspace=shared', { bearer: solo })).body.secrets).toEqual([])
    const bad = await h.call('GET', '/v1/secrets/effective?workspace=public', { bearer: solo })
    expect(bad.status).toBe(400)
    expect(bad.body).toMatchObject({ reason: 'invalid_workspace' })
  })
})
