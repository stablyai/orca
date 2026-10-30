import { describe, expect, it } from 'vitest'
import { PROJECT_RUNTIME_METHODS } from './project-runtime-rpc-methods'

// Restamp client-relative runtime ids as local; persisting them hides rows from other clients and breaks project/host deduplication.
function parseParams(methodName: string, params: unknown): { hostId: string } {
  const method = PROJECT_RUNTIME_METHODS.find((candidate) => candidate.name === methodName)
  if (!method?.params) {
    throw new Error(`Missing params schema for ${methodName}`)
  }
  return method.params.parse(params) as { hostId: string }
}

const CREATING_METHODS = [
  {
    name: 'projectHostSetup.setupExistingFolder',
    base: { projectId: 'github:stablyai/orca', path: '/srv/orca' }
  },
  {
    name: 'projectHostSetup.clone',
    base: {
      projectId: 'github:stablyai/orca',
      url: 'https://github.com/stablyai/orca.git',
      destination: '/srv'
    }
  },
  { name: 'projectHostSetup.create', base: { projectId: 'github:stablyai/orca' } }
] as const

describe('project host setup self-host stamp', () => {
  it.each(CREATING_METHODS)('$name stores a caller runtime id as local', ({ name, base }) => {
    const parsed = parseParams(name, { ...base, hostId: 'runtime:c0ffee-env-id' })

    expect(parsed.hostId).toBe('local')
  })

  it.each(CREATING_METHODS)('$name leaves an explicit local host alone', ({ name, base }) => {
    expect(parseParams(name, { ...base, hostId: 'local' }).hostId).toBe('local')
  })

  // Keep SSH target identity: it names another machine, while runtime here means this host.
  it.each(CREATING_METHODS)('$name preserves an ssh host', ({ name, base }) => {
    expect(parseParams(name, { ...base, hostId: 'ssh:box-1' }).hostId).toBe('ssh:box-1')
  })

  it.each(CREATING_METHODS)('$name still rejects an unparseable host', ({ name, base }) => {
    expect(() => parseParams(name, { ...base, hostId: 'nonsense' })).toThrow()
    expect(() => parseParams(name, { ...base, hostId: 'runtime:' })).toThrow()
  })

  // Two clients paired with the same server now converge on one row instead of one each.
  it('collapses two different clients onto the same host id', () => {
    const fromClientA = parseParams('projectHostSetup.create', {
      projectId: 'github:stablyai/orca',
      hostId: 'runtime:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })
    const fromClientB = parseParams('projectHostSetup.create', {
      projectId: 'github:stablyai/orca',
      hostId: 'runtime:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    })

    expect(fromClientA.hostId).toBe(fromClientB.hostId)
  })
})
