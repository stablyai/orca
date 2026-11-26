import { describe, expect, it, vi } from 'vitest'
import { addNgitComment, createNgitIssue, setNgitWorkItemStatus } from './work-item-mutations'
import { ngitErrorMessage } from './ngit-cli'

const target = { cwd: '/repo', repo: 'nostr://npub1x/demo' }

describe('ngit writes', () => {
  it('passes reader-written text as values that cannot become flags', async () => {
    const exec = vi.fn(async () => '{}')
    await createNgitIssue(target, '--nsec', '-f $(rm -rf .)', exec)
    await addNgitComment(target, 'pr', 'ab'.repeat(32), '--force', exec)
    expect(exec.mock.calls).toEqual([
      [
        [
          '--repo',
          target.repo,
          'issue',
          'create',
          '--subject=--nsec',
          '--body=-f $(rm -rf .)',
          '--json'
        ],
        '/repo'
      ],
      [
        ['--repo', target.repo, 'pr', 'comment', 'ab'.repeat(32), '--body=--force', '--json'],
        '/repo'
      ]
    ])
  })

  it('refuses a status the item type does not have, without running ngit', async () => {
    const exec = vi.fn(async () => '{}')
    await expect(
      setNgitWorkItemStatus(target, 'issue', 'ab'.repeat(32), 'ready', exec)
    ).resolves.toMatchObject({ ok: false })
    expect(exec).not.toHaveBeenCalled()
  })

  it('never repeats a secret from ngit output', () => {
    expect(
      ngitErrorMessage('{"command_status":"error","error":"bad key nsec1qqqsecret"}', '', 'x')
    ).toBe('bad key [redacted]')
  })
})
