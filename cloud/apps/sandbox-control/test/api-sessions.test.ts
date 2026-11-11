import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { safeFilename } from '../src/api/attachments'
import { tarGzipFile } from '../src/tar-gzip'
import { createHarness } from './harness'

async function harness() {
  const pending: Promise<unknown>[] = []
  const h = await createHarness({ PUBLIC_API_URL: 'https://api.test' }, { waitUntil: (p) => void pending.push(p) })
  /** Answers the in-VM orca CLI: launches return `term_new`, other terminal commands succeed. */
  h.vercel.commandHandler = (params) => {
    const args = params.args ?? []
    if (args.includes('launch')) {
      return { exitCode: 0, stdout: JSON.stringify({ ok: true, result: { outcome: { kind: 'terminal', handle: 'term_new' } } }), stderr: '' }
    }
    if (args.includes('terminal')) {
      return { exitCode: 0, stdout: JSON.stringify({ ok: true, result: {} }), stderr: '' }
    }
    return undefined
  }
  const orcaArgs = (verb: string) => h.vercel.commands.filter((c) => c.args?.includes(verb)).map((c) => c.args!.slice(c.args!.indexOf('orca') + 1))
  return { ...h, settle: () => Promise.all(pending.splice(0)), orcaArgs }
}

async function upload(h: Awaited<ReturnType<typeof harness>>, wsId: string, init: { body: BodyInit; contentType: string; query?: string; as?: string }) {
  const bearer = await h.token(init.as ?? 'alice')
  const response = await h.send(
    new Request(`https://sandbox.test/v1/workspaces/${wsId}/attachments${init.query ?? ''}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': init.contentType },
      body: init.body
    })
  )
  return { status: response.status, body: (await response.json()) as any }
}

describe('public API: models', () => {
  it('lists every image agent with its catalog models, efforts and defaults', async () => {
    const h = await harness()
    const res = await h.call('GET', '/v1/models')
    expect(res.status).toBe(200)
    const agents = res.body.agents as { id: string; default: boolean; defaultModel: string | null; models: { id: string; efforts: string[]; fastMode: boolean }[] }[]
    expect(agents.map((a) => a.id)).toEqual(['claude', 'codex', 'opencode', 'gemini', 'cursor', 'copilot'])
    const claude = agents.find((a) => a.id === 'claude')!
    expect(claude.default).toBe(true)
    expect(claude.defaultModel).toBe('sonnet')
    expect(claude.models.find((m) => m.id === 'opus')).toMatchObject({ efforts: expect.arrayContaining(['high', 'max']), fastMode: true })
    expect(agents.find((a) => a.id === 'codex')!.models.find((m) => m.id === 'gpt-5.5')!.efforts).toContain('xhigh')
    // Agents without a seed catalog still appear: their CLI picks the model.
    expect(agents.find((a) => a.id === 'copilot')).toMatchObject({ models: [], defaultModel: null })
  })
})

describe('public API: sessions', () => {
  it('starts a new session with model, effort, name and a first prompt, waking a sleeping workspace', async () => {
    const h = await harness()
    const ws = (await h.call('POST', '/v1/workspaces', { body: {} })).body.workspace
    await h.call('POST', `/v1/workspaces/${ws.id}/sleep`)
    const res = await h.call('POST', `/v1/workspaces/${ws.id}/sessions`, {
      body: { agent: 'codex', model: 'gpt-5.5', effort: 'high', name: 'Review', message: 'review the diff; $(rm -rf /)' }
    })
    expect(res.status).toBe(201)
    expect(res.body.session).toEqual({ handle: 'term_new', workspaceId: ws.id, agent: 'codex', model: 'gpt-5.5', effort: 'high', name: 'Review' })
    expect((await h.call('GET', `/v1/workspaces/${ws.id}`)).body.workspace.status).toBe('running')
    const [launch] = h.orcaArgs('launch')
    expect(launch).toEqual(expect.arrayContaining(['--agent', 'codex', '--model=gpt-5.5', '--effort=high', '--prompt=review the diff; $(rm -rf /)']))
    expect(h.orcaArgs('rename')[0]).toEqual(expect.arrayContaining(['--terminal', 'term_new', '--title=Review']))
    const actions = (await h.call('GET', '/v1/audit')).body.entries.map((e: { action: string }) => e.action)
    expect(actions[0]).toBe('workspace.session.create')
  })

  it('starts an idle session without a prompt and rejects bad model picks', async () => {
    const h = await harness()
    const ws = (await h.call('POST', '/v1/workspaces', { body: {} })).body.workspace
    expect((await h.call('POST', `/v1/workspaces/${ws.id}/sessions`, { body: {} })).status).toBe(201)
    expect(h.orcaArgs('launch')[0]!.some((arg) => arg.startsWith('--prompt'))).toBe(false)
    const badEffort = await h.call('POST', `/v1/workspaces/${ws.id}/sessions`, { body: { agent: 'claude', model: 'haiku', effort: 'high' } })
    expect(badEffort).toMatchObject({ status: 400, body: { error: 'invalid_request', reason: 'effort: haiku takes no effort' } })
    expect((await h.call('POST', `/v1/workspaces/${ws.id}/sessions`, { body: { effort: 'high' } })).status).toBe(400)
    expect((await h.call('POST', `/v1/workspaces/${ws.id}/sessions`, { body: { model: 'x y' } })).status).toBe(400)
    // A model newer than the catalog is passed through to the agent CLI.
    expect((await h.call('POST', `/v1/workspaces/${ws.id}/sessions`, { body: { model: 'claude-fable-9', effort: 'max' } })).status).toBe(201)
  })

  it('cancels a turn: drops the session\'s queued messages and interrupts with Escape', async () => {
    const h = await harness()
    const ws = (await h.call('POST', '/v1/workspaces', { body: {} })).body.workspace
    // Two messages still waiting for delivery (e.g. a retry backlog): one for this session, one not.
    const insert = h.raw.prepare(
      `INSERT INTO workspace_messages (id, sandbox_id, account_id, sent_by, agent, session_handle, body, status, created_at, updated_at) VALUES (?, ?, 'user:alice', 'alice', 'claude', ?, 'x', 'queued', 0, 0)`
    )
    insert.run('msg_q1', ws.id, 'term_abc')
    insert.run('msg_q2', ws.id, 'term_other')
    const res = await h.call('POST', `/v1/workspaces/${ws.id}/sessions/term_abc/cancel`)
    expect(res.body).toEqual({ workspaceId: ws.id, session: 'term_abc', interrupted: true, canceledQueuedMessages: 1 })
    expect((await h.call('GET', `/v1/workspaces/${ws.id}/messages/msg_q1`)).body.message).toMatchObject({ status: 'failed', error: 'canceled' })
    expect((await h.call('GET', `/v1/workspaces/${ws.id}/messages/msg_q2`)).body.message.status).toBe('queued')
    const send = h.orcaArgs('send').at(-1)!
    expect(send).toEqual(expect.arrayContaining(['--terminal', 'term_abc', '--text=\u001b']))
    expect(send).not.toContain('--enter')
    // Asleep: nothing to interrupt, and the VM is not woken for it.
    await h.call('POST', `/v1/workspaces/${ws.id}/sleep`)
    const asleep = await h.call('POST', `/v1/workspaces/${ws.id}/sessions/term_abc/cancel`)
    expect(asleep.body).toMatchObject({ interrupted: false, canceledQueuedMessages: 0 })
    expect((await h.call('GET', `/v1/workspaces/${ws.id}`)).body.workspace.status).toBe('sleeping')
    expect((await h.call('POST', `/v1/workspaces/${ws.id}/sessions/nope/cancel`)).status).toBe(404)
  })

  it('renames a session while running and 409s while asleep', async () => {
    const h = await harness()
    const ws = (await h.call('POST', '/v1/workspaces', { body: {} })).body.workspace
    const res = await h.call('POST', `/v1/workspaces/${ws.id}/sessions/term_abc/rename`, { body: { name: 'Docs pass' } })
    expect(res.body.session).toEqual({ handle: 'term_abc', workspaceId: ws.id, name: 'Docs pass' })
    await h.call('POST', `/v1/workspaces/${ws.id}/sleep`)
    expect((await h.call('POST', `/v1/workspaces/${ws.id}/sessions/term_abc/rename`, { body: { name: 'x' } })).status).toBe(409)
  })

  it('keeps teammates out of a private workspace\'s sessions', async () => {
    const h = await harness()
    const owner = await h.token('olive', 'acme', 'sandbox', { orgRole: 'owner' })
    const member = await h.token('mel', 'acme', 'sandbox', { orgRole: 'member' })
    const ws = (await h.call('POST', '/v1/workspaces', { bearer: owner, body: {} })).body.workspace
    expect((await h.call('POST', `/v1/workspaces/${ws.id}/sessions`, { bearer: member, body: {} })).status).toBe(404)
    expect((await h.call('POST', `/v1/workspaces/${ws.id}/sessions/term_abc/cancel`, { bearer: member })).status).toBe(404)
    expect((await h.call('POST', `/v1/workspaces/${ws.id}/rename`, { bearer: member, body: { name: 'x' } })).status).toBe(404)
  })
})

describe('public API: rename and unarchive', () => {
  it('renames a workspace everywhere it is listed', async () => {
    const h = await harness()
    const ws = (await h.call('POST', '/v1/workspaces', { body: { name: 'old' } })).body.workspace
    const res = await h.call('POST', `/v1/workspaces/${ws.id}/rename`, { body: { name: '  New name ' } })
    expect(res.body.workspace.name).toBe('New name')
    expect((await h.call('GET', `/v1/workspaces/${ws.id}`)).body.workspace.name).toBe('New name')
    expect((await h.call('GET', '/v1/team/workspaces')).body.workspaces[0].title).toBe('New name')
    expect((await h.call('POST', `/v1/workspaces/${ws.id}/rename`, { body: { name: '' } })).status).toBe(400)
  })

  it('unarchives back into lists and running, idempotently', async () => {
    const h = await harness()
    const ws = (await h.call('POST', '/v1/workspaces', { body: {} })).body.workspace
    await h.call('POST', `/v1/workspaces/${ws.id}/archive`)
    expect((await h.call('GET', '/v1/workspaces')).body.workspaces).toHaveLength(0)
    const res = await h.call('POST', `/v1/workspaces/${ws.id}/unarchive`)
    expect(res.body.workspace).toMatchObject({ status: 'running', archived: false })
    expect((await h.call('GET', '/v1/workspaces')).body.workspaces).toHaveLength(1)
    const again = await h.call('POST', `/v1/workspaces/${ws.id}/unarchive`)
    expect(again).toMatchObject({ status: 200, body: { workspace: { status: 'running', archived: false } } })
    const actions = (await h.call('GET', '/v1/audit')).body.entries.map((e: { action: string }) => e.action)
    expect(actions.filter((a: string) => a === 'workspace.unarchive')).toHaveLength(1)
  })
})

describe('public API: attachments', () => {
  it('writes raw and base64 uploads to the workspace disk and points the agent at them', async () => {
    const h = await harness()
    const ws = (await h.call('POST', '/v1/workspaces', { body: {} })).body.workspace
    const raw = await upload(h, ws.id, { body: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), contentType: 'image/png', query: '?filename=../../etc/Screen%20Shot%201.png' })
    expect(raw.status).toBe(201)
    const att = raw.body.attachment
    expect(att).toMatchObject({ workspaceId: ws.id, filename: 'Screen Shot 1.png', contentType: 'image/png', byteSize: 4 })
    expect(att.path).toBe(`/vercel/sandbox/attachments/${att.id}/Screen Shot 1.png`)
    const box = [...h.vercel.boxes.values()][0]!
    expect(Buffer.from(box.files.get(att.path)!, 'latin1')).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]))

    const json = await upload(h, ws.id, { body: JSON.stringify({ filename: 'log.txt', contentType: 'text/plain', data: Buffer.from('boom').toString('base64') }), contentType: 'application/json' })
    expect(json.body.attachment).toMatchObject({ filename: 'log.txt', byteSize: 4 })

    const sent = await h.call('POST', `/v1/workspaces/${ws.id}/messages`, { body: { text: 'see files', attachments: [att.id, json.body.attachment.id] } })
    expect(sent.status).toBe(202)
    await h.settle()
    const prompt = h.orcaArgs('launch')[0]!.at(-1)!
    expect(prompt).toContain('see files\n\nAttached files (read them from disk):')
    expect(prompt).toContain(`- ${att.path} (image/png, 4 bytes)`)
    expect(prompt).toContain(`- ${json.body.attachment.path} (text/plain, 4 bytes)`)
  })

  it('rejects unknown, foreign and oversized attachments', async () => {
    const h = await harness()
    const a = (await h.call('POST', '/v1/workspaces', { body: {} })).body.workspace
    const b = (await h.call('POST', '/v1/workspaces', { body: {} })).body.workspace
    const att = (await upload(h, b.id, { body: 'x', contentType: 'text/plain', query: '?filename=x.txt' })).body.attachment
    const foreign = await h.call('POST', `/v1/workspaces/${a.id}/messages`, { body: { text: 'hi', attachments: [att.id] } })
    expect(foreign).toMatchObject({ status: 400, body: { error: 'invalid_request' } })
    expect((await h.call('POST', `/v1/workspaces/${a.id}/messages`, { body: { text: 'hi', attachments: ['att_nope'] } })).status).toBe(400)
    expect((await upload(h, a.id, { body: 'x', contentType: 'text/plain' })).status).toBe(400)
    const big = await upload(h, a.id, { body: JSON.stringify({ filename: 'big.bin', data: Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64') }), contentType: 'application/json' })
    expect(big.status).toBe(413)
    // Another account cannot upload into it.
    expect((await upload(h, a.id, { body: 'x', contentType: 'text/plain', query: '?filename=x', as: 'mallory' })).status).toBe(404)
    // Attachments need a message on session create.
    expect((await h.call('POST', `/v1/workspaces/${b.id}/sessions`, { body: { attachments: [att.id] } })).status).toBe(400)
  })

  it('keeps file names to one safe path segment', () => {
    expect(safeFilename('../../.ssh/id_rsa')).toBe('id_rsa')
    expect(safeFilename('.env')).toBe('env')
    expect(safeFilename('résumé $(x).pdf')).toBe('resume __x_.pdf')
    expect(safeFilename('')).toBe('file')
    expect(safeFilename(`${'a'.repeat(300)}.png`)).toMatch(/^a{80}\.png$/)
  })

  it('packs a valid ustar archive the files API can extract', async () => {
    const bytes = new TextEncoder().encode('hello')
    const tgz = new Uint8Array(await tarGzipFile({ dirs: ['vercel', 'vercel/sandbox'], path: 'vercel/sandbox/a.txt', bytes, mtime: 1_700_000_000_000 }))
    const tar = gunzipSync(tgz)
    expect(tar.length % 512).toBe(0)
    const field = (block: number, offset: number, width: number) => tar.subarray(block * 512 + offset, block * 512 + offset + width).toString('latin1').replace(/\0.*$/s, '')
    expect([field(0, 0, 100), field(0, 156, 1), field(1, 0, 100), field(2, 0, 100), field(2, 156, 1)]).toEqual(['vercel/', '5', 'vercel/sandbox/', 'vercel/sandbox/a.txt', '0'])
    expect(parseInt(field(2, 124, 12), 8)).toBe(5)
    expect(field(2, 257, 6)).toBe('ustar')
    for (const block of [0, 1, 2]) {
      const header = Buffer.from(tar.subarray(block * 512, block * 512 + 512))
      const stored = parseInt(field(block, 148, 8), 8)
      header.fill(0x20, 148, 156)
      expect(header.reduce((sum, b) => sum + b, 0)).toBe(stored)
    }
    expect(tar.subarray(3 * 512, 3 * 512 + 5).toString()).toBe('hello')
    await expect(tarGzipFile({ dirs: [], path: '../x', bytes, mtime: 0 })).rejects.toThrow('tar_bad_path')
  })
})
