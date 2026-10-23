import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  _getGhRateLimitBlockCount,
  _resetGhRateLimitBreaker,
  classifyGhRateLimitBucket,
  createGhRateLimitBlockedError,
  getGhRateLimitBlockedUntilMs,
  isGhPrimaryRateLimitStderr,
  isGhLocalOnlyCommand,
  isGhRateLimitProbe,
  notifyGhPrimaryRateLimit,
  parseGhRateLimitScopeKey,
  recordGhPrimaryRateLimit,
  registerGhRateLimitResetProbe
} from './gh-rate-limit-breaker'

afterEach(() => {
  _resetGhRateLimitBreaker()
})

describe('classifyGhRateLimitBucket', () => {
  it('classifies search API endpoints, skipping flag values', () => {
    expect(
      classifyGhRateLimitBucket([
        'api',
        '--cache',
        '120s',
        'search/issues?q=repo:a/b is:issue is:open&per_page=1',
        '--jq',
        '.total_count'
      ])
    ).toBe('search')
    expect(classifyGhRateLimitBucket(['search', 'prs', '--author', 'x'])).toBe('search')
  })

  it('classifies the GraphQL endpoint and the GraphQL-backed subcommands Orca runs as graphql', () => {
    expect(classifyGhRateLimitBucket(['api', 'graphql', '-f', 'query=…'])).toBe('graphql')
    for (const args of [
      ['pr', 'list', '--limit', '36'],
      ['pr', 'view', '12', '--repo', 'github.com/a/b', '--json', 'number'],
      ['pr', 'checks', '12', '--json', 'name,state,link'],
      ['pr', 'create', '--repo', 'a/b', '--base', 'main', '--title', 't'],
      ['pr', 'merge', '12', '--squash'],
      ['pr', 'edit', '12', '--title', 't'],
      ['pr', 'ready', '12', '--repo', 'a/b'],
      ['pr', 'close', '12', '--repo', 'a/b'],
      ['pr', 'reopen', '12', '--repo', 'a/b'],
      ['issue', 'view', '5', '--json', 'body'],
      ['issue', 'list', '--json', 'number'],
      ['issue', 'close', '5', '--repo', 'a/b', '--reason', 'completed'],
      ['issue', 'reopen', '5', '--repo', 'a/b'],
      ['issue', 'edit', '5', '--repo', 'a/b', '--add-label', 'bug'],
      ['repo', 'view', 'a/b', '--json', 'isFork,parent']
    ]) {
      expect(classifyGhRateLimitBucket(args)).toBe('graphql')
    }
  })

  it('keeps REST endpoints and REST or unlisted subcommands on core', () => {
    expect(classifyGhRateLimitBucket(['api', 'repos/a/b/pulls?per_page=36'])).toBe('core')
    expect(classifyGhRateLimitBucket(['run', 'list', '--json', 'status'])).toBe('core')
    expect(classifyGhRateLimitBucket(['auth', 'status', '--hostname', 'github.com'])).toBe('core')
    expect(classifyGhRateLimitBucket(['pr'])).toBe('core')
  })
})

describe('isGhLocalOnlyCommand', () => {
  it('exempts keyring token reads and nothing else', () => {
    expect(
      isGhLocalOnlyCommand(['auth', 'token', '--user', 'alice', '--hostname', 'github.com'])
    ).toBe(true)
    expect(isGhLocalOnlyCommand(['auth', 'token', '--help'])).toBe(true)
    expect(isGhLocalOnlyCommand(['auth', 'status'])).toBe(false)
    expect(isGhLocalOnlyCommand(['auth', 'refresh', '-s', 'project'])).toBe(false)
    expect(isGhLocalOnlyCommand(['api', 'user'])).toBe(false)
  })
})

describe('isGhRateLimitProbe', () => {
  it('recognizes the exempt rate_limit endpoint only', () => {
    expect(isGhRateLimitProbe(['api', 'rate_limit'])).toBe(true)
    expect(isGhRateLimitProbe(['api', '/rate_limit'])).toBe(true)
    expect(isGhRateLimitProbe(['api', '--hostname', 'github.com', 'rate_limit'])).toBe(true)
    expect(isGhRateLimitProbe(['api', 'search/issues?q=x'])).toBe(false)
    expect(isGhRateLimitProbe(['pr', 'list'])).toBe(false)
  })
})

describe('isGhPrimaryRateLimitStderr', () => {
  it('matches primary rate-limit 403s but not secondary limits', () => {
    expect(
      isGhPrimaryRateLimitStderr(
        'gh: API rate limit exceeded for user ID 1775218. If you reach out to GitHub Support… (HTTP 403)'
      )
    ).toBe(true)
    expect(
      isGhPrimaryRateLimitStderr('GraphQL: API rate limit already exceeded for user ID 1775218.')
    ).toBe(true)
    expect(isGhPrimaryRateLimitStderr('You have exceeded a secondary rate limit.')).toBe(false)
    expect(isGhPrimaryRateLimitStderr('gh: Not Found (HTTP 404)')).toBe(false)
  })
})

describe('parseGhRateLimitScopeKey', () => {
  it('parses native and wsl scopes, keeping ported hosts intact', () => {
    expect(parseGhRateLimitScopeKey('native:github.com')).toEqual({
      runtime: 'native',
      host: 'github.com'
    })
    expect(parseGhRateLimitScopeKey('native:ghe.corp:8443')).toEqual({
      runtime: 'native',
      host: 'ghe.corp:8443'
    })
    expect(parseGhRateLimitScopeKey('wsl:ubuntu:github.com')).toEqual({
      runtime: 'wsl',
      wslDistro: 'ubuntu',
      host: 'github.com'
    })
    expect(parseGhRateLimitScopeKey('wsl:ubuntu:ghe.corp:8443')).toEqual({
      runtime: 'wsl',
      wslDistro: 'ubuntu',
      host: 'ghe.corp:8443'
    })
  })

  it('rejects malformed scopes', () => {
    expect(parseGhRateLimitScopeKey('native:')).toBeNull()
    expect(parseGhRateLimitScopeKey('wsl:ubuntu')).toBeNull()
    expect(parseGhRateLimitScopeKey('wsl:ubuntu:')).toBeNull()
    expect(parseGhRateLimitScopeKey('ssh:github.com')).toBeNull()
  })
})

describe('breaker state', () => {
  it('blocks until the recorded time, then expires', () => {
    const now = 1_000_000
    recordGhPrimaryRateLimit('search', now + 5_000)
    expect(getGhRateLimitBlockedUntilMs('search', now)).toBe(now + 5_000)
    expect(getGhRateLimitBlockedUntilMs('core', now)).toBeNull()
    expect(getGhRateLimitBlockedUntilMs('search', now + 5_001)).toBeNull()
    // Expiry is sticky — the entry was removed on the expired read.
    expect(getGhRateLimitBlockedUntilMs('search', now)).toBeNull()
  })

  it('keeps the later of two recorded reset times', () => {
    const now = 1_000_000
    recordGhPrimaryRateLimit('core', now + 60_000)
    recordGhPrimaryRateLimit('core', now + 10_000)
    expect(getGhRateLimitBlockedUntilMs('core', now)).toBe(now + 60_000)
  })

  it('isolates blocks by host and execution runtime scope', () => {
    const now = 1_000_000
    recordGhPrimaryRateLimit('core', now + 60_000, 'native:github.com')

    expect(getGhRateLimitBlockedUntilMs('core', now, 'native:github.com')).toBe(now + 60_000)
    expect(getGhRateLimitBlockedUntilMs('core', now, 'native:github.acme-corp.com')).toBeNull()
    expect(getGhRateLimitBlockedUntilMs('core', now, 'wsl:ubuntu:github.com')).toBeNull()
  })

  it('bounds retained blocks across user-supplied Enterprise host scopes', () => {
    const now = Date.now()
    for (let i = 0; i < 1_200; i += 1) {
      recordGhPrimaryRateLimit('core', now + 60_000, `native:ghe-${i}.example.test`)
    }

    expect(_getGhRateLimitBlockCount()).toBe(1024)
    expect(getGhRateLimitBlockedUntilMs('core', now, 'native:ghe-1199.example.test')).toBe(
      now + 60_000
    )
    expect(getGhRateLimitBlockedUntilMs('core', now, 'native:ghe-0.example.test')).toBeNull()
  })

  it('keeps a recently-read active scope when the bounded map evicts', () => {
    const now = Date.now()
    const hotScope = 'native:active.example.test'
    recordGhPrimaryRateLimit('core', now + 60_000, hotScope)
    for (let i = 0; i < 1_023; i += 1) {
      recordGhPrimaryRateLimit('core', now + 60_000, `native:cold-${i}.example.test`)
    }

    expect(getGhRateLimitBlockedUntilMs('core', now, hotScope)).toBe(now + 60_000)
    recordGhPrimaryRateLimit('core', now + 60_000, 'native:new.example.test')

    expect(getGhRateLimitBlockedUntilMs('core', now, hotScope)).toBe(now + 60_000)
    expect(getGhRateLimitBlockedUntilMs('core', now, 'native:cold-0.example.test')).toBeNull()
  })

  it('notifyGhPrimaryRateLimit applies a fallback block and fires the reset probe', () => {
    const probe = vi.fn()
    registerGhRateLimitResetProbe(probe)
    notifyGhPrimaryRateLimit('search')
    expect(probe).toHaveBeenCalledWith('search', 'native:github.com')
    expect(getGhRateLimitBlockedUntilMs('search')).toBeGreaterThan(Date.now())
  })

  it('fires the reset probe with the tripping scope for non-default scopes', () => {
    // Why: a WSL-only Windows install (or GHES) would otherwise stay on the
    // blunt 5-minute fallback forever — the probe must learn which scope to
    // query.
    const probe = vi.fn()
    registerGhRateLimitResetProbe(probe)

    notifyGhPrimaryRateLimit('core', 'native:github.acme-corp.com')
    notifyGhPrimaryRateLimit('core', 'wsl:ubuntu:github.com')

    expect(probe).toHaveBeenNthCalledWith(1, 'core', 'native:github.acme-corp.com')
    expect(probe).toHaveBeenNthCalledWith(2, 'core', 'wsl:ubuntu:github.com')
    expect(
      getGhRateLimitBlockedUntilMs('core', Date.now(), 'native:github.acme-corp.com')
    ).not.toBeNull()
  })

  it('creates an error that classifies as rate_limited, not permission_denied', () => {
    const error = createGhRateLimitBlockedError('search', Date.now() + 30_000)
    expect(error.stderr.toLowerCase()).toContain('rate limit')
    expect(error.stderr.toLowerCase()).not.toContain('403')
    expect(error.ghRateLimitBlocked).toBe(true)
  })
})
