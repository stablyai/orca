import { expect, it } from 'vitest'
import { codexApprovalItem } from './codex-structured-prompt-items'

const ask = (params: Record<string, unknown>, announcedChanges?: unknown) =>
  codexApprovalItem({
    method:
      params.changes || announcedChanges
        ? 'item/fileChange/requestApproval'
        : 'item/commandExecution/requestApproval',
    params: { threadId: 't', turnId: 'u', itemId: 'i', startedAtMs: 1, ...params },
    detail: null,
    announcedChanges
  }).requestDigest

it('matches a re-asked request only when everything it would do is the same', () => {
  const deploy = { command: './deploy', cwd: '/repo' }
  const first = ask(deploy)

  expect(first).toBeDefined()
  expect(
    ask({ ...deploy, itemId: 'other', approvalId: 'a2', startedAtMs: 99, reason: 'again' })
  ).toBe(first)
  expect(ask({ ...deploy, additionalPermissions: { write: ['/Users/me'] } })).not.toBe(first)
  expect(ask({ ...deploy, environmentId: 'remote' })).not.toBe(first)
  expect(ask({ ...deploy, command: '' })).toBeUndefined()

  const patch = [{ path: 'a.ts', diff: '+x' }]
  expect(ask({ grantRoot: null }, patch)).toBeDefined()
  expect(ask({ grantRoot: null }, patch)).not.toBe(
    ask({ grantRoot: null }, [{ path: 'a.ts', diff: '+y' }])
  )
})
