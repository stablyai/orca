// Edge-native director configuration and its pure rules: off unless DIRECTOR_HOSTNAME is set and
// valid, and country routing to the front door.
import { describe, expect, it } from 'vitest'
import { directorCellUrl, parseDirectorConfig } from '../src/director-config'
import { DIRECTOR_HOST, EDGE_URL, FRONT_DOOR_URL } from './director-fixture'

const VALID = { DIRECTOR_HOSTNAME: DIRECTOR_HOST, DIRECTOR_EDGE_URL: EDGE_URL, DIRECTOR_FRONT_DOOR_URL: FRONT_DOOR_URL }

describe('director config', () => {
  it('parses a valid setup; the front door is optional and defaults to CN', () => {
    expect(parseDirectorConfig({ ...VALID, DIRECTOR_HOSTNAME: 'Director-Next.Relay.Example' }).config).toEqual({
      hostname: DIRECTOR_HOST,
      edgeUrl: EDGE_URL,
      frontDoorUrl: FRONT_DOOR_URL,
      frontDoorCountries: ['CN']
    })
    expect(parseDirectorConfig({ DIRECTOR_HOSTNAME: DIRECTOR_HOST, DIRECTOR_EDGE_URL: EDGE_URL }).config?.frontDoorUrl).toBeNull()
    expect(parseDirectorConfig({ ...VALID, DIRECTOR_FRONT_DOOR_COUNTRIES: 'cn, hk' }).config?.frontDoorCountries).toEqual(['CN', 'HK'])
  })

  it('stays off and names the problem for a malformed setup', () => {
    const problems = (vars: Record<string, string>) => parseDirectorConfig({ ...VALID, ...vars })
    expect(problems({ DIRECTOR_EDGE_URL: '' })).toEqual({ config: null, problems: ['edge_url_invalid'] })
    expect(problems({ DIRECTOR_EDGE_URL: 'https://edge.relay.example/' }).problems).toEqual(['edge_url_invalid'])
    expect(problems({ DIRECTOR_EDGE_URL: 'http://edge.relay.example' }).problems).toEqual(['edge_url_invalid'])
    expect(problems({ DIRECTOR_FRONT_DOOR_URL: 'cn.relay.example' }).problems).toEqual(['front_door_url_invalid'])
    expect(problems({ DIRECTOR_FRONT_DOOR_COUNTRIES: 'China' }).problems).toEqual(['countries_invalid'])
    expect(problems({ DIRECTOR_HOSTNAME: 'https://director' }).problems).toEqual(['hostname_invalid'])
    // Handing out the director's own host as a cell would send clients in a loop.
    expect(problems({ DIRECTOR_EDGE_URL: `https://${DIRECTOR_HOST}` }).problems).toEqual(['cell_url_is_director'])
  })
})

describe('country routing', () => {
  const config = parseDirectorConfig({ ...VALID, DIRECTOR_FRONT_DOOR_COUNTRIES: 'CN,HK' }).config!

  it('sends the front door countries to the front door and everyone else to the edge', () => {
    expect(directorCellUrl(config, 'CN')).toBe(FRONT_DOOR_URL)
    expect(directorCellUrl(config, 'hk')).toBe(FRONT_DOOR_URL)
    expect(directorCellUrl(config, 'US')).toBe(EDGE_URL)
    expect(directorCellUrl(config, 'TW')).toBe(EDGE_URL)
    expect(directorCellUrl(config, undefined)).toBe(EDGE_URL)
  })

  it('without a front door, everyone gets the edge', () => {
    const edgeOnly = parseDirectorConfig({ DIRECTOR_HOSTNAME: DIRECTOR_HOST, DIRECTOR_EDGE_URL: EDGE_URL }).config!
    expect(directorCellUrl(edgeOnly, 'CN')).toBe(EDGE_URL)
  })
})
