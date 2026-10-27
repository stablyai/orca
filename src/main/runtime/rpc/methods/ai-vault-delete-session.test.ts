import '../unused-default-rpc-methods.test-fixture'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type * as NodeOs from 'node:os'
import { afterAll, describe, expect, it, vi } from 'vitest'

const home = vi.hoisted(() => ({ dir: '' }))
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeOs>()
  return { ...actual, homedir: () => home.dir }
})

home.dir = realpathSync(mkdtempSync(join(tmpdir(), 'orca-ai-vault-host-delete-')))

const { RpcDispatcher } = await import('../dispatcher')
const { AI_VAULT_METHODS } = await import('./ai-vault')
const { RuntimeAiVaultCommands } = await import('../../runtime-ai-vault-commands')
const { RUNTIME_CAPABILITIES } = await import('../../../../shared/protocol-version')
const { AI_VAULT_DELETE_SESSION_RUNTIME_CAPABILITY } =
  await import('../../../../shared/ai-vault-runtime-capabilities')

function dispatcher(): InstanceType<typeof RpcDispatcher> {
  const vault = new RuntimeAiVaultCommands(() => null)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the delete handler reads only this member.
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    deleteAiVaultSession: vault.delete.bind(vault)
  } as unknown as ConstructorParameters<typeof RpcDispatcher>[0]['runtime']
  return new RpcDispatcher({ runtime, methods: AI_VAULT_METHODS })
}

function writeSession(name: string): string {
  const dir = join(home.dir, '.gemini', 'tmp', 'project-a')
  mkdirSync(dir, { recursive: true })
  const filePath = join(dir, name)
  writeFileSync(filePath, '{}')
  return filePath
}

afterAll(() => {
  rmSync(home.dir, { recursive: true, force: true })
})

describe('aiVault.deleteSession', () => {
  it('is advertised so clients can tell an older host apart', () => {
    expect(RUNTIME_CAPABILITIES).toContain(AI_VAULT_DELETE_SESSION_RUNTIME_CAPABILITY)
  })

  it("permanently deletes a transcript under this host's own roots", async () => {
    const filePath = writeSession('session-1.json')

    const response = await dispatcher().dispatch({
      id: 'req-1',
      authToken: 'tok',
      method: 'aiVault.deleteSession',
      // A client host stamp is not trusted; the host deletes only its own files.
      params: { agent: 'gemini', sessionId: 'session-1', filePath, executionHostId: 'ssh:other' }
    })

    expect(response).toMatchObject({ ok: true, result: { outcome: 'deleted' } })
    expect(existsSync(filePath)).toBe(false)
  })

  it('refuses a path outside the host roots and leaves it on disk', async () => {
    const outside = join(home.dir, 'notes.json')
    writeFileSync(outside, '{}')

    const response = await dispatcher().dispatch({
      id: 'req-2',
      authToken: 'tok',
      method: 'aiVault.deleteSession',
      params: { agent: 'gemini', filePath: outside }
    })

    expect(response).toMatchObject({
      ok: true,
      result: { outcome: 'rejected', reason: 'path-outside-known-roots' }
    })
    expect(existsSync(outside)).toBe(true)
  })
})
