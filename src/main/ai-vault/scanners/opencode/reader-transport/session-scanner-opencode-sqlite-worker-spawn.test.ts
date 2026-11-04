import { expect, it, vi } from 'vitest'
import type * as OpenCodeWslClient from './session-scanner-opencode-wsl-client'
import type { OpenCodeSqliteWorkerClient } from './session-scanner-opencode-sqlite-worker-client'
import type { AiVaultScanIssue } from '../../../../../shared/ai-vault/contracts/ai-vault-types'
import { listOpenCodeSqliteSessionsViaWorker } from './session-scanner-opencode-sqlite-worker-spawn'

const mocks = vi.hoisted(() => ({ list: vi.fn<OpenCodeSqliteWorkerClient['list']>() }))
vi.mock('./session-scanner-opencode-wsl-client', async (importOriginal) => {
  const { parseWslUncPath } = await import('../../../../../shared/wsl-paths')
  return {
    ...(await importOriginal<typeof OpenCodeWslClient>()),
    openCodeWslPath: parseWslUncPath,
    openCodeWslClient: async () => ({ list: mocks.list })
  }
})

it('routes scoped SQLite reads only to the owning distro and reports a scoped-only failure', async () => {
  const ubuntu = String.raw`\\wsl.localhost\Ubuntu\home\ada\opencode.db`
  const debian = String.raw`\\wsl.localhost\Debian\home\ada\opencode.db`
  const issues: AiVaultScanIssue[] = []
  mocks.list.mockImplementation(async (args) => {
    if (args.scopePaths?.length) {
      expect(args.scopePaths).toEqual(['/home/ada/repo'])
      args.issues.push({
        agent: 'opencode',
        kind: 'scope',
        path: args.dbPaths[0],
        message: 'Scoped read timed out'
      })
    }
    return []
  })
  await listOpenCodeSqliteSessionsViaWorker({ dbPaths: [ubuntu], limit: 1, issues })
  await listOpenCodeSqliteSessionsViaWorker({
    dbPaths: [ubuntu, debian],
    limit: 1,
    issues,
    scopePaths: [String.raw`\\wsl.localhost\Ubuntu\home\ada\repo`]
  })
  expect(mocks.list).toHaveBeenCalledTimes(2)
  expect(issues).toEqual([
    { agent: 'opencode', kind: 'scope', path: ubuntu, message: 'Scoped read timed out' }
  ])
})
