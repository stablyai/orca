// Edge-native director configuration and its pure rules: off unless DIRECTOR_HOSTNAME is set and
// valid, country routing to the front door, and the static region catalog.
import { describe, expect, it } from 'vitest'
import { DIRECTOR_PROBE_PREFIXES, REGION_LOCATION_HINT, dialledHostname, directorCellUrl, directorRegionCatalog, parseDirectorConfig } from '../src/director-config'
import { RelayRegionCatalogResponseSchema } from '../../../packages/relay-contract/src/relay-regions'
import { DIRECTOR_HOST, EDGE_URL, FRONT_DOOR_URL } from './director-fixture'

const VALID = { DIRECTOR_HOSTNAME: DIRECTOR_HOST, DIRECTOR_EDGE_URL: EDGE_URL, DIRECTOR_FRONT_DOOR_URL: FRONT_DOOR_URL }

describe('director config', () => {
  it('is off, silently, without DIRECTOR_HOSTNAME (every environment today)', () => {
    expect(parseDirectorConfig({})).toEqual({ config: null, problems: [] })
    expect(parseDirectorConfig({ DIRECTOR_HOSTNAME: '', DIRECTOR_EDGE_URL: EDGE_URL })).toEqual({ config: null, problems: [] })
  })

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

  it('matches on the hostname the client dialled: a trusted ingress origin, else the URL', () => {
    const request = new Request(`https://edge.relay.example/v1/assign`)
    expect(dialledHostname(request, null)).toBe('edge.relay.example')
    expect(dialledHostname(request, { origin: `https://${DIRECTOR_HOST}` })).toBe(DIRECTOR_HOST)
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

describe('region catalog', () => {
  it('is the contract shape, every probe origin a subdomain of the director host', () => {
    const catalog = directorRegionCatalog(DIRECTOR_HOST)
    expect(RelayRegionCatalogResponseSchema.parse(catalog)).toEqual(catalog)
    expect(catalog).toEqual({
      v: 1,
      regions: [
        { region: 'us-central1', probeOrigins: [`https://${DIRECTOR_PROBE_PREFIXES['us-central1']}.${DIRECTOR_HOST}`] },
        { region: 'asia-east2', probeOrigins: [`https://${DIRECTOR_PROBE_PREFIXES['asia-east2']}.${DIRECTOR_HOST}`] }
      ]
    })
  })

  it('maps each region to a location hint for new objects', () => {
    expect(REGION_LOCATION_HINT).toEqual({ 'us-central1': 'enam', 'asia-east2': 'apac' })
  })
})
