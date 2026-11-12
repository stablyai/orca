// CREATE-GIT-ASYNC: a create answers once orcad is ready and installs member git identities after
// (ctx.waitUntil). The VM is told the setup is pending so its `git` holds commits and pushes; fetches
// use the workspace credential the boot already put in the egress policy. Wake, resume and restart
// still install identities before they answer.
import { describe, expect, it } from 'vitest'
import type { RunCommandParams } from '../src/sandbox-provider'
import { GIT_SETUP_MARK_SCRIPT, MEMBERS_COMMAND, githubPlaceholderToken } from '../src/lifecycle'
import { START_COMMAND } from '../src/sandbox-vm-commands'
import { gitBasicAuthorization } from '../src/network-policy'
import { getSandbox } from '../src/store'
import { createHarness } from './harness'

const PROXY_URL = 'https://sandbox.test/v1/egress/proxy'
const REPO = 'https://github.com/acme/app'
const OP = 'o'.repeat(40)
const GIT_SETUP_AWARE = { 'x-orca-sandbox-features': 'git-setup' }

type Gate = { open: () => void; wait: Promise<void> }
function gate(): Gate {
  let open = (): void => {}
  const wait = new Promise<void>((resolve) => {
    open = resolve
  })
  return { open, wait }
}

async function setup() {
  const background: Promise<unknown>[] = []
  const h = await createHarness(
    { EGRESS_PROXY_URL: PROXY_URL, SECRETS_KEK: Buffer.alloc(32, 7).toString('base64'), OPERATOR_TOKEN: OP },
    {
      waitUntil: (work: Promise<unknown>) => void background.push(work),
      credentials: { authorizationFor: async () => 'Bearer ghs_app' },
      github: {
        tokenForRepo: async () => ({ token: 'ghs_repo_token', expiresAt: h.now() + 3_600_000 }),
        installationForRepo: async () => null
      } as never
    }
  )
  // The members install waits on `members` until the test opens it, or answers with `membersExit`.
  let members: Gate | null = null
  let membersExit = 0
  h.vercel.commandHandler = (params: RunCommandParams) => {
    if (params.command !== MEMBERS_COMMAND) {
      return undefined
    }
    const answer = { exitCode: membersExit, stdout: '{"members":1,"devices":1}\n', stderr: '' }
    return members ? members.wait.then(() => answer) : Promise.resolve(answer)
  }
  const as = (sub: string) => h.token(sub, 'acme', 'sandbox', { org_role: 'member' })
  // The creator connected GitHub, so their identity is one the VM installs.
  await h.call('POST', '/v1/internal/dev/member-github', {
    bearer: OP,
    body: { accountId: 'org:acme', userId: 'alice', repoUrl: REPO, login: 'alice-gh', githubUserId: 11, name: 'alice name' }
  })
  const create = async () =>
    h.call('POST', '/v1/sandboxes', {
      bearer: await as('alice'),
      body: { workspaceId: `ws-${Math.random()}`, machineSize: 'standard', repo: { url: REPO }, visibility: 'team' }
    })
  const startEnvs = () => h.vercel.commands.filter((c) => c.command === START_COMMAND).map((c) => c.env)
  const marks = () =>
    h.vercel.commands.filter((c) => c.command === 'bash' && c.args?.[1] === GIT_SETUP_MARK_SCRIPT).map((c) => c.args?.[3])
  const membersRuns = () => h.vercel.commands.filter((c) => c.command === MEMBERS_COMMAND)
  const settle = async () => {
    await Promise.allSettled(background.splice(0))
  }
  return {
    h,
    as,
    create,
    startEnvs,
    marks,
    membersRuns,
    settle,
    hold: () => (members = gate()),
    release: () => members?.open(),
    failMembers: (code: number) => (membersExit = code)
  }
}

describe('create answers before member git setup', () => {
  it('answers while the members install is still running, and tells the VM setup is pending', async () => {
    const t = await setup()
    const held = t.hold()
    const created = await t.create()
    expect(created.status).toBe(200)
    // The VM's git holds commits and pushes on this mark until the install finishes.
    expect(t.startEnvs().at(-1)?.ORCA_GIT_SETUP).toBe('pending')
    expect(created.body.sandbox.gitSetup).toBeUndefined()
    held.open()
    await t.settle()
    // The owner's own device is what the VM maps to the owner (git as the sender).
    const payload = JSON.parse(Buffer.from(t.membersRuns().at(-1)!.env.ORCA_MEMBERS_B64!, 'base64').toString())
    expect(payload.map((m: { userId: string }) => m.userId)).toContain('alice')
  })

  it('an immediate fetch works before the install finishes: the boot already routed the repo credential', async () => {
    const t = await setup()
    t.hold()
    const created = await t.create()
    const row = (await getSandbox(t.h.env.SANDBOX_DB, created.body.sandbox.id))!
    const box = [...t.h.vercel.boxes.values()].find((b) => b.params.name.endsWith(row.id))!
    expect(JSON.stringify(box.policy.allow['github.com'])).toContain(gitBasicAuthorization(githubPlaceholderToken(row)))
    t.release()
    await t.settle()
  })

  it('a failed install marks the VM setup failed and reports gitSetup "failed" until a later sync succeeds', async () => {
    const t = await setup()
    t.failMembers(1)
    const created = await t.create()
    const id: string = created.body.sandbox.id
    await t.settle()
    expect(t.marks()).toContain('failed')
    const view = await t.h.call('GET', `/v1/sandboxes/${id}`, { bearer: await t.as('alice'), headers: GIT_SETUP_AWARE })
    expect(view.body.sandbox.gitSetup).toBe('failed')
    // Desktops that do not send the feature parse the view strictly and never see the field.
    const strict = await t.h.call('GET', `/v1/sandboxes/${id}`, { bearer: await t.as('alice') })
    expect(strict.body.sandbox.gitSetup).toBeUndefined()
    // A restart whose install fails again keeps the failure (VM mark and flag): never a silent broken state.
    const marksBefore = t.marks().length
    const again = await t.h.call('POST', `/v1/sandboxes/${id}/restart`, { bearer: await t.as('alice') })
    expect(again.status).toBe(200)
    expect(t.marks().slice(marksBefore)).toEqual(['failed'])
    const still = await t.h.call('GET', `/v1/sandboxes/${id}`, { bearer: await t.as('alice'), headers: GIT_SETUP_AWARE })
    expect(still.body.sandbox.gitSetup).toBe('failed')
    // Restart is the retry: it installs identities before it answers, and a success clears the failure.
    t.failMembers(0)
    const restarted = await t.h.call('POST', `/v1/sandboxes/${id}/restart`, { bearer: await t.as('alice') })
    expect(restarted.status).toBe(200)
    expect(t.startEnvs().at(-1)?.ORCA_GIT_SETUP).toBeUndefined()
    const after = await t.h.call('GET', `/v1/sandboxes/${id}`, { bearer: await t.as('alice'), headers: GIT_SETUP_AWARE })
    expect(after.body.sandbox.gitSetup).toBeUndefined()
  })

  it('a member who is not the creator gets their identity when they connect, before that call answers', async () => {
    const t = await setup()
    const created = await t.create()
    const id: string = created.body.sandbox.id
    await t.settle()
    const before = t.membersRuns().length
    const bob = await t.as('bob')
    const { generateGrantRecipientKey } = await import('../../../../src/main/cloud-workspaces/sealed-grant-node')
    const issued = await t.h.call('POST', `/v1/team/workspaces/${id}/grants`, {
      bearer: bob,
      body: { recipientPublicKeyB64: generateGrantRecipientKey().publicKeyB64, deviceLabel: 'b', deviceKind: 'desktop' }
    })
    expect(issued.status).toBe(200)
    // The grant path is unchanged: synchronous, nothing left in the background.
    expect(t.membersRuns().length).toBe(before + 1)
  })

  it('sleeping before the background install finishes still ends with identities installed on wake', async () => {
    const t = await setup()
    const held = t.hold()
    const created = await t.create()
    const id: string = created.body.sandbox.id
    const alice = await t.as('alice')
    expect((await t.h.call('POST', `/v1/sandboxes/${id}/suspend`, { bearer: alice })).status).toBe(200)
    // The VM is gone: the held install fails and is recorded, never retried against a stopped box.
    held.open()
    await t.settle()
    t.release()
    const runsBeforeWake = t.membersRuns().length
    const resumed = await t.h.call('POST', `/v1/sandboxes/${id}/resume`, { bearer: alice })
    expect(resumed.status).toBe(200)
    // Wake installs identities before it answers (the owner's device is connected), with no pending mark.
    expect(t.membersRuns().length).toBeGreaterThan(runsBeforeWake)
    expect(t.startEnvs().at(-1)?.ORCA_GIT_SETUP).toBeUndefined()
    const view = await t.h.call('GET', `/v1/sandboxes/${id}`, { bearer: alice, headers: GIT_SETUP_AWARE })
    expect(view.body.sandbox.gitSetup).toBeUndefined()
  })
})
