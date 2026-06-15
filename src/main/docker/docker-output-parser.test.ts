import { describe, expect, it } from 'vitest'
import { parseDockerContainers } from './docker-output-parser'

const LINE_RUNNING = JSON.stringify({
  ID: 'abc123',
  Names: 'web,web-alias',
  Image: 'nginx:latest',
  State: 'running',
  Status: 'Up 3 minutes',
  Labels: 'com.docker.compose.project=shop,maintainer=acme'
})

const LINE_EXITED = JSON.stringify({
  ID: 'def456',
  Names: 'db',
  Image: 'postgres:16',
  State: 'exited',
  Status: 'Exited (0) 1 hour ago',
  Labels: ''
})

describe('parseDockerContainers', () => {
  it('parses one summary per non-empty JSON line', () => {
    const result = parseDockerContainers(`${LINE_RUNNING}\n${LINE_EXITED}\n`)
    expect(result).toEqual([
      {
        id: 'abc123',
        names: ['web', 'web-alias'],
        image: 'nginx:latest',
        state: 'running',
        status: 'Up 3 minutes',
        composeProject: 'shop'
      },
      {
        id: 'def456',
        names: ['db'],
        image: 'postgres:16',
        state: 'exited',
        status: 'Exited (0) 1 hour ago',
        composeProject: undefined
      }
    ])
  })

  it('skips blank and malformed lines instead of throwing', () => {
    const result = parseDockerContainers(`\n  \nnot-json\n${LINE_RUNNING}`)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('abc123')
  })

  it('maps an unrecognized state to "unknown"', () => {
    const line = JSON.stringify({ ID: 'x', Names: 'x', Image: 'x', State: 'weird', Status: '' })
    expect(parseDockerContainers(line)[0].state).toBe('unknown')
  })

  it('returns an empty array for empty stdout', () => {
    expect(parseDockerContainers('')).toEqual([])
  })

  it('tolerates a container row with a missing ID', () => {
    const line = JSON.stringify({ Names: 'x', Image: 'nginx', State: 'running', Status: '' })
    expect(parseDockerContainers(line)[0]).toMatchObject({ id: '', names: ['x'] })
  })
})
