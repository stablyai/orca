import { describe, expect, it } from 'vitest'
import { RelayAssignRateGate } from './relay-assign-rate-gate'
import { RelayHttpError, requestRelayAssignment } from './relay-http-client'

const DIRECTOR_URL = 'https://director.example.test'
const CELL_URL = 'https://cell-a.example.test'

function assignmentAnswer(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { v: 1, cellUrl: CELL_URL, assignmentEpoch: 3, lease: 'lease-token', ...extra }
}

function fakeDirector(answer: Record<string, unknown>) {
  const requests: { url: string; headers: Headers }[] = []
  const fetch: typeof globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), headers: new Headers(init?.headers) })
    return new Response(JSON.stringify(answer), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  }
  return { fetch, requests }
}

function assign(fetch: typeof globalThis.fetch) {
  return requestRelayAssignment({
    directorUrl: DIRECTOR_URL,
    relayToken: 'relay-token',
    relayHostId: 'host-under-test',
    fetch,
    assignRateGate: new RelayAssignRateGate()
  })
}

describe('requestRelayAssignment origin alternates', () => {
  it('advertises origin-alternates-v1 on POST /v1/assign', async () => {
    const director = fakeDirector(assignmentAnswer())
    await assign(director.fetch)
    expect(director.requests).toHaveLength(1)
    expect(director.requests[0].url).toBe(`${DIRECTOR_URL}/v1/assign`)
    expect(director.requests[0].headers.get('x-orca-host-capabilities')).toBe(
      'origin-alternates-v1, front-door-auth-v1'
    )
  })

  it('accepts a legacy assignment without optional routing fields', async () => {
    const assignment = await assign(fakeDirector(assignmentAnswer()).fetch)
    expect(assignment).toStrictEqual({
      v: 1,
      cellUrl: 'https://cell-a.example.test',
      assignmentEpoch: 3,
      lease: 'lease-token'
    })
  })

  it('carries valid alternates through in order', async () => {
    const alternates = ['https://edge.example.test', 'https://front-door.example.test']
    const assignment = await assign(
      fakeDirector(assignmentAnswer({ alternateCellUrls: alternates })).fetch
    )
    expect(assignment).toEqual(assignmentAnswer({ alternateCellUrls: alternates }))
  })

  it('drops entries equal to cellUrl, duplicated, or not canonical https origins', async () => {
    const cases: [unknown, string[] | undefined][] = [
      [[CELL_URL, 'https://edge.example.test'], ['https://edge.example.test']],
      [['https://edge.example.test', 'https://edge.example.test'], ['https://edge.example.test']],
      [['http://edge.example.test', 'https://edge.example.test/path'], undefined],
      [['https://edge.example.test/', 42], undefined],
      [[CELL_URL], undefined],
      [[], undefined],
      ['https://edge.example.test', undefined],
      [{ url: 'https://edge.example.test' }, undefined],
      [null, undefined]
    ]
    for (const [alternateCellUrls, expected] of cases) {
      const assignment = await assign(fakeDirector(assignmentAnswer({ alternateCellUrls })).fetch)
      expect(assignment.cellUrl).toBe(CELL_URL)
      expect(assignment.alternateCellUrls).toEqual(expected)
    }
  })

  it('reads at most two alternates', async () => {
    const assignment = await assign(
      fakeDirector(
        assignmentAnswer({
          alternateCellUrls: [
            'https://one.example.test',
            'https://two.example.test',
            'https://three.example.test'
          ]
        })
      ).fetch
    )
    expect(assignment.alternateCellUrls).toEqual([
      'https://one.example.test',
      'https://two.example.test'
    ])
  })

  it('still rejects unknown keys and an invalid cellUrl', async () => {
    await expect(assign(fakeDirector(assignmentAnswer({ surprise: true })).fetch)).rejects.toThrow(
      RelayHttpError
    )
    await expect(
      assign(
        fakeDirector(
          assignmentAnswer({
            cellUrl: 'https://cell-a.example.test/path',
            alternateCellUrls: ['https://edge.example.test']
          })
        ).fetch
      )
    ).rejects.toThrow(RelayHttpError)
  })
})

describe('requestRelayAssignment authOrigin', () => {
  const DOOR = 'https://front-door.example.test'

  it('keeps an authOrigin equal to cellUrl or one of the alternates', async () => {
    const onDoor = await assign(
      fakeDirector({ ...assignmentAnswer({ authOrigin: DOOR }), cellUrl: DOOR }).fetch
    )
    expect(onDoor).toMatchObject({ cellUrl: DOOR, authOrigin: DOOR })
    const viaAlternate = await assign(
      fakeDirector(assignmentAnswer({ alternateCellUrls: [DOOR], authOrigin: DOOR })).fetch
    )
    expect(viaAlternate).toMatchObject({ cellUrl: CELL_URL, authOrigin: DOOR })
  })

  it('ignores an invalid authOrigin or one this assignment does not connect to', async () => {
    for (const authOrigin of [
      'https://elsewhere.example.test',
      'http://front-door.example.test',
      `${CELL_URL}/`,
      `${CELL_URL}/v1`,
      42,
      null,
      [CELL_URL]
    ]) {
      const assignment = await assign(fakeDirector(assignmentAnswer({ authOrigin })).fetch)
      expect(assignment.cellUrl).toBe(CELL_URL)
      expect('authOrigin' in assignment).toBe(false)
    }
  })
})
