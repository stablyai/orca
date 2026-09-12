import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises'
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

describe('session scanner cutoff', () => {
  it.each(['native', 'remote'] as const)(
    '%s does not sort timestamps at every post-limit candidate',
    async (host) => {
      const count = 128
      const limit = count / 2
      const provider = new MemoryRemoteProvider()
      const root = await mkdtemp(join(tmpdir(), 'orca-session-cutoff-'))
      tempRoots.push(root)
      const roots = isolatedScanRoots(root)
      await mkdir(roots.codexSessionsDir, { recursive: true })
      for (let index = 0; index < count; index++) {
        const name = `rollout-session-${index}.jsonl`
        const content = jsonLines([
          { type: 'session_meta', payload: { id: `session-${index}`, cwd: '/repo/folder' } },
          {
            type: 'event_msg',
            timestamp: new Date(index).toISOString(),
            payload: { type: 'user_message', message: 'Check this session' }
          }
        ])
        const mtime = 10_000 - index
        if (host === 'native') {
          const filePath = join(roots.codexSessionsDir, name)
          await writeFile(filePath, content)
          await utimes(filePath, new Date(mtime), new Date(mtime))
        } else {
          provider.addFile(`/home/ada/.codex/sessions/${name}`, content, mtime)
        }
      }
      let numericSorts = 0
      const originalSort = Array.prototype.sort
      vi.spyOn(Array.prototype, 'sort').mockImplementation(function (this: unknown[], compare) {
        if (typeof this[0] === 'number') {
          numericSorts++
        }
        return originalSort.call(this, compare)
      })
      const scan = () =>
        host === 'native'
          ? scanAiVaultSessions({ ...roots, limit })
          : scanRemoteAiVaultSessions({
              provider,
              remoteHome: '/home/ada',
              hostPlatform: getRemoteHostPlatform('linux-x64'),
              executionHostId: 'ssh:scan-cutoff',
              limit
            })

      for (let pass = 0; pass < 2; pass++) {
        numericSorts = 0
        const result = await scan()
        expect(result.issues).toEqual([])
        expect(result.sessions.map((row) => row.sessionId)).toEqual(
          Array.from({ length: limit }, (_, index) => `session-${count - index - 1}`)
        )
        expect(numericSorts).toBe(0)
      }
    }
  )
})
