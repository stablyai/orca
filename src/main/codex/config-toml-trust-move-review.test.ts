import { describe, expect, it } from 'vitest'
import { collectPrependedRemoteUserTrustMoves } from './codex-hook-remote-user-trust-moves'
import { moveHookTrustEntriesInContent, readHookTrustEntriesFromContent } from './config-toml-trust'

describe('review: index moves preserve approval absence and disablement', () => {
  it('moves a disabled user hook even when it has no trusted hash', () => {
    const source = '/home/dev/.codex/hooks.json:stop:0:0'
    const target = '/home/dev/.codex/hooks.json:stop:1:0'
    const input = `[hooks.state."${source}"]\nenabled = false\n`
    const output = moveHookTrustEntriesInContent(input, [{ fromKey: source, toKey: target }])
    const states = readHookTrustEntriesFromContent(output)
    expect.soft(states.get(target)).toMatchObject({ enabled: false })
    expect.soft(states.get(target)?.trustedHash).toBeUndefined()
    expect.soft(states.has(source)).toBe(false)
  })
})

describe('index moves: simultaneous shifts, collisions, and no synthesized approval', () => {
  const base = '/home/dev/.codex/hooks.json:stop'

  it('shifts two adjacent rows without giving the disabled no-hash hook a hash', () => {
    const input = [
      `[hooks.state."${base}:0:0"]`,
      'enabled = false',
      '',
      `[hooks.state."${base}:1:0"]`,
      'enabled = false',
      'trusted_hash = "sha256:user-b"',
      ''
    ].join('\n')
    const output = moveHookTrustEntriesInContent(input, [
      { fromKey: `${base}:0:0`, toKey: `${base}:1:0` },
      { fromKey: `${base}:1:0`, toKey: `${base}:2:0` }
    ])
    const states = readHookTrustEntriesFromContent(output)
    expect(states.get(`${base}:1:0`)).toMatchObject({ enabled: false })
    expect(states.get(`${base}:1:0`)?.trustedHash).toBeUndefined()
    expect(states.get(`${base}:2:0`)).toEqual({ enabled: false, trustedHash: 'sha256:user-b' })
    expect(states.has(`${base}:0:0`)).toBe(false)
    expect(output).toContain(`[hooks.state."${base}:1:0"]\nenabled = false\n`)
    expect(output).not.toContain(`[hooks.state."${base}:1:0"]\nenabled = false\ntrusted_hash`)
  })

  it('applies the same chain when move order is reversed', () => {
    const input = [
      `[hooks.state."${base}:0:0"]`,
      'enabled = false',
      '',
      `[hooks.state."${base}:1:0"]`,
      'enabled = true',
      'trusted_hash = "sha256:user-b"',
      ''
    ].join('\n')
    const moves = [
      { fromKey: `${base}:0:0`, toKey: `${base}:1:0` },
      { fromKey: `${base}:1:0`, toKey: `${base}:2:0` }
    ]
    const forward = readHookTrustEntriesFromContent(moveHookTrustEntriesInContent(input, moves))
    const reverse = readHookTrustEntriesFromContent(
      moveHookTrustEntriesInContent(input, moves.toReversed())
    )
    expect(forward.get(`${base}:1:0`)).toEqual(reverse.get(`${base}:1:0`))
    expect(forward.get(`${base}:2:0`)).toEqual(reverse.get(`${base}:2:0`))
    expect(forward.has(`${base}:0:0`)).toBe(false)
    expect(reverse.has(`${base}:0:0`)).toBe(false)
  })

  it('does not adopt a colliding destination hash when moving a disabled no-hash row', () => {
    const source = `${base}:0:0`
    const target = `${base}:1:0`
    const input = [
      `[hooks.state."${source}"]`,
      'enabled = false',
      '',
      `[hooks.state."${target}"]`,
      'enabled = true',
      'trusted_hash = "sha256:destination"',
      ''
    ].join('\n')
    const output = moveHookTrustEntriesInContent(input, [{ fromKey: source, toKey: target }])
    const states = readHookTrustEntriesFromContent(output)
    expect(states.get(target)).toMatchObject({ enabled: false })
    expect(states.get(target)?.trustedHash).toBeUndefined()
    expect(states.has(source)).toBe(false)
    expect(output).not.toContain('sha256:destination')
  })

  it('keeps a disabled hashed approval intact across the same index shift', () => {
    const source = `${base}:0:0`
    const target = `${base}:1:0`
    const input = [
      `[hooks.state."${source}"]`,
      'enabled = false',
      'trusted_hash = "sha256:user-approved"',
      ''
    ].join('\n')
    const states = readHookTrustEntriesFromContent(
      moveHookTrustEntriesInContent(input, [{ fromKey: source, toKey: target }])
    )
    expect(states.get(target)).toEqual({ enabled: false, trustedHash: 'sha256:user-approved' })
    expect(states.has(source)).toBe(false)
  })

  it('is a no-op when the collected prepend move is already at the target index', () => {
    const key = `${base}:1:0`
    const input = `[hooks.state."${key}"]\nenabled = false\n`
    expect(moveHookTrustEntriesInContent(input, [{ fromKey: key, toKey: key }])).toBe(input)
  })

  it('matches repeated remote prepend collection to a same-index no-op', () => {
    const sourcePath = '/home/dev/.codex/hooks.json'
    const userHook = { hooks: [{ type: 'command' as const, command: 'echo user-stop' }] }
    const managed = {
      hooks: [{ type: 'command' as const, command: '/home/dev/.orca/codex-hook.sh' }]
    }
    const isManaged = (command: string | undefined) => Boolean(command?.includes('codex-hook.sh'))
    const first = collectPrependedRemoteUserTrustMoves(
      sourcePath,
      'Stop',
      [userHook],
      [userHook],
      isManaged
    )
    expect(first).toEqual([{ fromKey: `${sourcePath}:stop:0:0`, toKey: `${sourcePath}:stop:1:0` }])
    const repeated = collectPrependedRemoteUserTrustMoves(
      sourcePath,
      'Stop',
      [managed, userHook],
      [userHook],
      isManaged
    )
    expect(repeated).toEqual([
      { fromKey: `${sourcePath}:stop:1:0`, toKey: `${sourcePath}:stop:1:0` }
    ])
  })
})
