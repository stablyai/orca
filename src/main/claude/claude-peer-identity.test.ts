import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudePeerIdentityReader } from './claude-peer-identity'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-peer-'))
})
afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})

async function session(configDir: string, contents: string, filename = '123.json') {
  await mkdir(join(configDir, 'sessions'), { recursive: true })
  await writeFile(join(configDir, 'sessions', filename), contents)
}

const metadata = JSON.stringify({
  pid: 123,
  name: 'main-fc',
  permissionMode: 'default',
  messagingSocketPath: '/private/socket'
})

describe('Claude peer identity', () => {
  it('honors the host CLAUDE_CONFIG_DIR when no launch override is supplied', async () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', root)
    await session(root, metadata)
    expect((await new ClaudePeerIdentityReader(undefined, '').read('claude', 123))?.agentName).toBe(
      'main-fc'
    )
  })

  it('reads only public name, pid and known permission mode from the custom config directory', async () => {
    await session(root, metadata)
    await session(root, 'secret', '123.deadbeef.key')
    expect(await new ClaudePeerIdentityReader(root, '').read('claude', 123)).toEqual({
      agentName: 'main-fc',
      agentPid: 123,
      permissionMode: 'default'
    })
  })

  it('finds account homes using the existing profile layout', async () => {
    await session(join(root, 'data', 'claude-profiles', 'account-a', 'home'), metadata)
    expect(
      await new ClaudePeerIdentityReader(join(root, 'default'), join(root, 'data')).read(
        'claude',
        123
      )
    ).toMatchObject({ agentName: 'main-fc', agentPid: 123 })
  })

  it.each([
    '',
    '{invalid',
    'null',
    '[]',
    '{"pid":124,"name":"wrong"}',
    '{"pid":123,"name":""}',
    '{"pid":123,"name":"bad\\nname"}'
  ])('ignores missing or invalid session metadata: %s', async (contents) => {
    if (contents) {
      await session(root, contents)
    }
    expect(await new ClaudePeerIdentityReader(root, '').read('claude', 123)).toBeUndefined()
  })

  it('does nothing for non-Claude agents or an unknown pid', async () => {
    await session(root, metadata)
    const reader = new ClaudePeerIdentityReader(root, '')
    expect(await reader.read('codex', 123)).toBeUndefined()
    expect(await reader.read(null, 123)).toBeUndefined()
    expect(await reader.read('claude', null)).toBeUndefined()
    expect(await reader.read('claude', -123)).toBeUndefined()
  })

  it('refreshes changed and removed names after a bounded cache interval', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    await session(root, metadata)
    const reader = new ClaudePeerIdentityReader(root, '')
    expect((await reader.read('claude', 123))?.agentName).toBe('main-fc')
    await session(root, JSON.stringify({ pid: 123, name: 'renamed-peer' }))
    vi.advanceTimersByTime(2_001)
    expect(await reader.read('claude', 123)).toEqual({ agentName: 'renamed-peer', agentPid: 123 })
    await rm(join(root, 'sessions', '123.json'))
    vi.advanceTimersByTime(2_001)
    expect(await reader.read('claude', 123)).toBeUndefined()
  })

  it('does not read oversized metadata', async () => {
    await session(root, JSON.stringify({ pid: 123, name: 'main-fc', extra: 'x'.repeat(65_536) }))
    expect(await new ClaudePeerIdentityReader(root, '').read('claude', 123)).toBeUndefined()
  })
})
