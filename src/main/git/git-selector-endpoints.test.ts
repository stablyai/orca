import { expect, it, vi } from 'vitest'
import { captureGitSelectorEndpoints } from './git-selector-endpoints'

it('rejects excessive literal selectors before issuing host commands', async () => {
  const run = vi.fn()
  await expect(
    captureGitSelectorEndpoints(
      new Map([
        ['branch.a.pushremote', 'https://github.com/a/repo'],
        ['branch.b.remote', 'https://github.com/b/repo']
      ]),
      [],
      run,
      2
    )
  ).rejects.toThrow('too many URLs')
  expect(run).not.toHaveBeenCalled()
})

it('deduplicates literals and avoids configured synthetic-name collisions', async () => {
  const url = 'https://github.com/canonical/repo'
  const run = vi.fn(async () => ({
    stdout: [
      'orca-operation-selector--\thttps://github.com/canonical/repo (fetch)',
      'orca-operation-selector--\thttps://github.com/canonical/repo (push)',
      'orca-operation-selector\thttps://github.com/wrong/repo (push)'
    ].join('\n')
  }))
  const result = await captureGitSelectorEndpoints(
    new Map([
      ['branch.a.pushremote', url],
      ['remote.pushdefault', url],
      ['remote.orca-operation-selector-.pushurl', 'https://github.com/wrong/repo']
    ]),
    ['orca-operation-selector'],
    run,
    2
  )
  expect(run).toHaveBeenCalledExactlyOnceWith([
    '-c',
    `remote.orca-operation-selector--.url=${url}`,
    'remote',
    '-v'
  ])
  expect(result.get(url)).toEqual({ fetch: url, push: [url] })
})

it('propagates execution-host failures without inventing local endpoint evidence', async () => {
  const run = vi.fn().mockRejectedValue(new Error('Remote connection dropped.'))
  await expect(
    captureGitSelectorEndpoints(
      new Map([['branch.feature.pushremote', 'ssh://example.invalid/repo']]),
      [],
      run,
      2
    )
  ).rejects.toThrow('Remote connection dropped.')
  expect(run).toHaveBeenCalledTimes(1)
})
