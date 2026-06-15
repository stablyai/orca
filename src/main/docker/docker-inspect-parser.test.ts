import { describe, expect, it } from 'vitest'
import { parseDockerInspect } from './docker-inspect-parser'

const RAW = JSON.stringify([
  {
    Id: 'abc123def456',
    Created: '2026-06-15T10:00:00.000Z',
    Config: { Env: ['PATH=/usr/bin', 'NODE_ENV=production'] },
    Mounts: [
      { Type: 'bind', Source: '/host/data', Destination: '/data', Mode: 'rw', RW: true },
      { Type: 'volume', Source: 'vol1', Destination: '/var/lib', Mode: '', RW: false }
    ],
    NetworkSettings: {
      Ports: {
        '80/tcp': [{ HostIp: '0.0.0.0', HostPort: '8080' }],
        '443/tcp': null
      }
    },
    HostConfig: { RestartPolicy: { Name: 'unless-stopped' } }
  }
])

describe('parseDockerInspect', () => {
  it('parses the first element of the inspect array', () => {
    const result = parseDockerInspect(RAW)
    expect(result).toEqual({
      id: 'abc123def456',
      createdAt: '2026-06-15T10:00:00.000Z',
      env: ['PATH=/usr/bin', 'NODE_ENV=production'],
      mounts: [
        { type: 'bind', source: '/host/data', destination: '/data', mode: 'rw', rw: true },
        { type: 'volume', source: 'vol1', destination: '/var/lib', mode: '', rw: false }
      ],
      ports: [
        { containerPort: '80/tcp', hostIp: '0.0.0.0', hostPort: '8080' },
        { containerPort: '443/tcp', hostIp: '', hostPort: '' }
      ],
      restartPolicy: 'unless-stopped'
    })
  })

  it('returns null for malformed JSON, an empty array, or a non-array', () => {
    expect(parseDockerInspect('not-json')).toBeNull()
    expect(parseDockerInspect('[]')).toBeNull()
    expect(parseDockerInspect('{}')).toBeNull()
  })

  it('tolerates missing optional sections', () => {
    const result = parseDockerInspect(JSON.stringify([{ Id: 'x' }]))
    expect(result).toEqual({
      id: 'x',
      createdAt: '',
      env: [],
      mounts: [],
      ports: [],
      restartPolicy: ''
    })
  })
})
