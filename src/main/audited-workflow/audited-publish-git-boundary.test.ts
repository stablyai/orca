// Phase 9 boundary proofs. These assert STRUCTURAL properties: they drive
// assertPublishNetworkShape with hand-built argv, because the guarantees must
// hold for any argv, not merely for what the builders happen to produce.
import { describe, expect, it } from 'vitest'
import {
  assertPublishNetworkShape,
  buildLeasedPushArgv,
  buildLsRemoteArgv
} from './audited-publish-commands'
import { assertAuditedGitArgvShape, isReadOnlyAuditedArgv } from './audited-worktree-commands'

const SHA = 'a'.repeat(40)
const OLD = 'b'.repeat(40)
const REF = 'refs/heads/feature'

function push(...extra: string[]): string[] {
  return ['push', `--force-with-lease=${REF}:${OLD}`, ...extra, '--', 'origin', `${SHA}:${REF}`]
}

describe('publish push shape — never a blind force', () => {
  it('accepts the explicit lease form', () => {
    expect(() => assertPublishNetworkShape(push(), {})).not.toThrow()
  })

  it('accepts the create-only empty lease', () => {
    const argv = ['push', `--force-with-lease=${REF}:`, '--', 'origin', `${SHA}:${REF}`]
    expect(() => assertPublishNetworkShape(argv, {})).not.toThrow()
  })

  it('rejects a BARE --force-with-lease', () => {
    const argv = ['push', '--force-with-lease', '--', 'origin', `${SHA}:${REF}`]
    expect(() => assertPublishNetworkShape(argv, {})).toThrow(/bare --force-with-lease/)
  })

  it('rejects a push with no lease at all', () => {
    const argv = ['push', '--', 'origin', `${SHA}:${REF}`]
    expect(() => assertPublishNetworkShape(argv, {})).toThrow(/exactly one explicit/)
  })

  it.each([['--force'], ['-f']])('rejects %s', (flag) => {
    const argv = ['push', flag, `--force-with-lease=${REF}:${OLD}`, '--', 'origin', `${SHA}:${REF}`]
    expect(() => assertPublishNetworkShape(argv, {})).toThrow(/--force is never permitted/)
  })

  it.each([
    ['--mirror'],
    ['--all'],
    ['--tags'],
    ['--follow-tags'],
    ['--delete'],
    ['-d'],
    ['--prune'],
    ['--recurse-submodules']
  ])('rejects the destructive push flag %s', (flag) => {
    expect(() => assertPublishNetworkShape(push(flag), {})).toThrow(/never permitted/)
  })

  it('rejects two leases', () => {
    const argv = [
      'push',
      `--force-with-lease=${REF}:${OLD}`,
      `--force-with-lease=${REF}:${SHA}`,
      '--',
      'origin',
      `${SHA}:${REF}`
    ]
    expect(() => assertPublishNetworkShape(argv, {})).toThrow(/exactly one explicit/)
  })

  it('rejects a lease whose expected value is not a full OID', () => {
    const argv = ['push', `--force-with-lease=${REF}:abc123`, '--', 'origin', `${SHA}:${REF}`]
    expect(() => assertPublishNetworkShape(argv, {})).toThrow(/full 40-hex OID or empty/)
  })

  it('rejects a lease on a non-branch ref', () => {
    const argv = [
      'push',
      `--force-with-lease=refs/tags/v1:${OLD}`,
      '--',
      'origin',
      `${SHA}:refs/tags/v1`
    ]
    expect(() => assertPublishNetworkShape(argv, {})).toThrow(/refs\/heads\//)
  })
})

describe('publish refspec shape — the SHA, never HEAD', () => {
  it('rejects HEAD as the refspec source', () => {
    const argv = ['push', `--force-with-lease=${REF}:${OLD}`, '--', 'origin', `HEAD:${REF}`]
    expect(() => assertPublishNetworkShape(argv, {})).toThrow(/never HEAD/)
  })

  it('rejects a branch name as the refspec source', () => {
    const argv = ['push', `--force-with-lease=${REF}:${OLD}`, '--', 'origin', `feature:${REF}`]
    expect(() => assertPublishNetworkShape(argv, {})).toThrow(/never HEAD/)
  })

  it('rejects a refspec whose destination is not the leased ref', () => {
    const argv = [
      'push',
      `--force-with-lease=${REF}:${OLD}`,
      '--',
      'origin',
      `${SHA}:refs/heads/other`
    ]
    expect(() => assertPublishNetworkShape(argv, {})).toThrow(/must be the leased ref/)
  })

  it('rejects more than one refspec', () => {
    const argv = [
      'push',
      `--force-with-lease=${REF}:${OLD}`,
      '--',
      'origin',
      `${SHA}:${REF}`,
      `${SHA}:refs/heads/other`
    ]
    expect(() => assertPublishNetworkShape(argv, {})).toThrow(/exactly one remote and one refspec/)
  })

  it('requires operands to be separated by --', () => {
    const argv = ['push', `--force-with-lease=${REF}:${OLD}`, 'origin', `${SHA}:${REF}`]
    expect(() => assertPublishNetworkShape(argv, {})).toThrow(/separate operands with --/)
  })
})

describe('publish env policy', () => {
  it.each([['GIT_OBJECT_DIRECTORY'], ['GIT_ALTERNATE_OBJECT_DIRECTORIES']])(
    'rejects %s, which would redirect the object store',
    (key) => {
      expect(() => assertPublishNetworkShape(push(), { [key]: '/tmp/objects' })).toThrow(
        /must be unset/
      )
    }
  )

  it.each([['--git-dir'], ['--work-tree'], ['--namespace'], ['--index-file']])(
    'rejects %s, which would re-point Git',
    (option) => {
      const argv = [
        'push',
        `${option}=/tmp/x`,
        `--force-with-lease=${REF}:${OLD}`,
        '--',
        'origin',
        `${SHA}:${REF}`
      ]
      expect(() => assertPublishNetworkShape(argv, {})).toThrow(/re-point Git/)
    }
  )
})

describe('publish path admits only push and ls-remote', () => {
  it.each([
    ['fetch', ['fetch', 'origin']],
    ['pull', ['pull']],
    ['clone', ['clone', 'url']],
    ['commit-tree', ['commit-tree', SHA]],
    ['update-ref', ['update-ref', REF, SHA, OLD]]
  ])('rejects %s on the publish path', (_label, argv) => {
    expect(() => assertPublishNetworkShape(argv, {})).toThrow(
      /only for network commands|disallowed/
    )
  })

  it('accepts ls-remote', () => {
    expect(() =>
      assertPublishNetworkShape(buildLsRemoteArgv('origin', 'feature'), {})
    ).not.toThrow()
  })
})

describe('builders produce screened argv', () => {
  it('builds a lease-protected push that passes both screens', () => {
    const argv = buildLeasedPushArgv({
      remote: 'origin',
      branch: 'feature',
      sha: SHA,
      expectedRemoteSha: OLD
    })
    expect(argv).toEqual([
      'push',
      `--force-with-lease=${REF}:${OLD}`,
      '--',
      'origin',
      `${SHA}:${REF}`
    ])
    expect(() => assertAuditedGitArgvShape(argv)).not.toThrow()
    expect(() => assertPublishNetworkShape(argv, {})).not.toThrow()
    expect(isReadOnlyAuditedArgv(argv)).toBe(false)
  })

  it('builds the create-only empty lease when the remote ref is absent', () => {
    const argv = buildLeasedPushArgv({
      remote: 'origin',
      branch: 'feature',
      sha: SHA,
      expectedRemoteSha: null
    })
    expect(argv[1]).toBe(`--force-with-lease=${REF}:`)
    expect(() => assertPublishNetworkShape(argv, {})).not.toThrow()
  })

  it('refuses to build a push from a non-OID source', () => {
    expect(() =>
      buildLeasedPushArgv({
        remote: 'origin',
        branch: 'feature',
        sha: 'HEAD',
        expectedRemoteSha: OLD
      })
    ).toThrow(/full 40-hex OID/)
  })

  it.each([['--evil'], ['a b'], ['origin/../x']])(
    'refuses a remote name with an unsupported shape: %s',
    (remote) => {
      expect(() => buildLsRemoteArgv(remote, 'feature')).toThrow(/remote name/)
    }
  )

  it.each([['--evil'], ['a..b'], ['feature.lock']])(
    'refuses a branch name with an unsupported shape: %s',
    (branch) => {
      expect(() => buildLsRemoteArgv('origin', branch)).toThrow(/branch name/)
    }
  )
})
