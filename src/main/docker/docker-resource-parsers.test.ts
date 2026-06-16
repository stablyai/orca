import { describe, expect, it } from 'vitest'
import {
  parseDockerImages,
  parseDockerVolumes,
  parseDockerNetworks
} from './docker-resource-parsers'

describe('parseDockerImages', () => {
  it('parses image lines and maps <none> through verbatim', () => {
    const lines = [
      JSON.stringify({ ID: 'img1', Repository: 'nginx', Tag: 'latest', Size: '142MB', CreatedSince: '2 days ago' }),
      JSON.stringify({ ID: 'img2', Repository: '<none>', Tag: '<none>', Size: '918MB', CreatedSince: '11 days ago' })
    ].join('\n')
    expect(parseDockerImages(lines)).toEqual([
      { id: 'img1', repository: 'nginx', tag: 'latest', size: '142MB', createdSince: '2 days ago' },
      { id: 'img2', repository: '<none>', tag: '<none>', size: '918MB', createdSince: '11 days ago' }
    ])
  })
  it('skips malformed lines', () => {
    expect(parseDockerImages('not-json\n')).toEqual([])
  })
})

describe('parseDockerVolumes', () => {
  it('parses volume lines', () => {
    const line = JSON.stringify({ Name: 'vol1', Driver: 'local', Scope: 'local', Mountpoint: '/var/lib/docker/volumes/vol1/_data' })
    expect(parseDockerVolumes(line)).toEqual([
      { name: 'vol1', driver: 'local', scope: 'local', mountpoint: '/var/lib/docker/volumes/vol1/_data' }
    ])
  })
})

describe('parseDockerNetworks', () => {
  it('parses network lines', () => {
    const line = JSON.stringify({ ID: 'net1', Name: 'bridge', Driver: 'bridge', Scope: 'local' })
    expect(parseDockerNetworks(line)).toEqual([
      { id: 'net1', name: 'bridge', driver: 'bridge', scope: 'local' }
    ])
  })
})
