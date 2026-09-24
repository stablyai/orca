import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getRemoteHostPlatform } from '../ssh/ssh-remote-platform'
import { scanRemoteAiVaultSessions } from './remote-session-scanner'
import { MemoryRemoteProvider } from './remote-session-scanner-test-fixtures'
import { scanAiVaultSessions } from './session-scanner'
import { isolatedScanRoots, jsonLines } from './session-scanner-test-fixtures'

const tempRoots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('session scan batch deduplication', () => {
  it.each(['native', 'remote'] as const)(
    '%s does not rederive every retained rollout alias after each batch',
    async (host) => {
      const count = 128
      const provider = new MemoryRemoteProvider()
      const root = await mkdtemp(join(tmpdir(), 'orca-session-dedup-'))
      tempRoots.push(root)
      const roots = isolatedScanRoots(root)
      await mkdir(roots.codexSessionsDir, { recursive: true })
      for (let index = 0; index < count; index++) {
        const name = `rollout-session-${index}.jsonl`
        const content = jsonLines([
          { type: 'session_meta', payload: { id: `session-${index}`, cwd: '/repo/folder' } },
          { type: 'event_msg', payload: { type: 'user_message', message: 'Check this session' } }
        ])
        if (host === 'native') {
          await writeFile(join(roots.codexSessionsDir, name), content)
        } else {
          provider.addFile(`/home/ada/.codex/sessions/${name}`, content, count - index)
        }
      }
      let aliasChecks = 0
      const originalTest = RegExp.prototype.test
      vi.spyOn(RegExp.prototype, 'test').mockImplementation(function (this: RegExp, value) {
        if (this.source === '^rollout-.+\\.jsonl$') {
          aliasChecks++
        }
        return originalTest.call(this, value)
      })
      const scan = () =>
        host === 'native'
          ? scanAiVaultSessions({ ...roots, unlimited: true })
          : scanRemoteAiVaultSessions({
              provider,
              remoteHome: '/home/ada',
              hostPlatform: getRemoteHostPlatform('linux-x64'),
              executionHostId: 'ssh:dedup-batches',
              unlimited: true
            })

      for (let pass = 0; pass < 2; pass++) {
        aliasChecks = 0
        const result = await scan()
        expect(result.issues).toEqual([])
        expect(result.sessions).toHaveLength(count)
        expect(new Set(result.sessions.map((session) => session.sessionId)).size).toBe(count)
        expect(aliasChecks).toBeLessThanOrEqual(count * 8)
      }
    }
  )

  it('replaces aliases across remote batches without consuming the unique-session budget', async () => {
    const provider = new MemoryRemoteProvider()
    const managedHome = '/home/ada/.local/share/orca/codex-runtime-home/home'
    const content = (id: string) =>
      jsonLines([
        { type: 'session_meta', payload: { id, cwd: '/repo/folder' } },
        { type: 'event_msg', payload: { type: 'user_message', message: 'Session' } }
      ])
    for (let index = 0; index < 8; index++) {
      const name = `rollout-${index}.jsonl`
      provider.addFile(`/home/ada/.codex/sessions/${name}`, content(`${index}`), 1000 - index)
      provider.addFile(`${managedHome}/sessions/${name}`, content(`${index}`), 500 - index)
    }
    provider.addFile('/home/ada/.codex/sessions/rollout-unique.jsonl', content('unique'), 100)
    const tooOld = '/home/ada/.codex/sessions/rollout-too-old.jsonl'
    provider.addFile(tooOld, content('too-old'), 50)
    const reads = vi.spyOn(provider, 'readFile')
    const result = await scanRemoteAiVaultSessions({
      provider,
      remoteHome: '/home/ada',
      hostPlatform: getRemoteHostPlatform('linux-x64'),
      executionHostId: 'ssh:batch-replacements',
      limit: 9
    })
    expect(result.issues).toEqual([])
    expect(result.sessions.map((session) => session.sessionId)).toEqual([
      '0',
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      'unique'
    ])
    expect(result.sessions.slice(0, 8).every((session) => session.codexHome === managedHome)).toBe(
      true
    )
    expect(reads).not.toHaveBeenCalledWith(tooOld)
  })
})
