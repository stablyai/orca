import { describe, expect, it } from 'vitest'
import { legacyC4ToScryModel } from './legacy-c4'
import type { C4ModelData } from '../../../../shared/scryer/model-types'

describe('legacy C4 adapter', () => {
  it('maps legacy C4 fields into ScryModel explicitly and drops view-only fields', () => {
    const legacy: C4ModelData = {
      nodes: [
        {
          id: 'api',
          type: 'c4',
          position: { x: 1, y: 2 },
          selected: true,
          data: {
            name: 'API',
            description: 'Serves requests',
            kind: 'system',
            technology: 'Node',
            external: false,
            expanded: true,
            _needsLayout: true,
            properties: [{ label: 'Port', description: 'HTTP port' }]
          }
        }
      ],
      edges: [
        {
          id: 'edge-api-db',
          source: 'api',
          target: 'db',
          data: { label: 'uses', method: 'SQL', _route: [{ x: 1, y: 1 }] }
        }
      ],
      groups: [{ id: 'group-1', name: 'Runtime', memberIds: ['api'] }],
      sourceMap: { api: [{ pattern: 'src/api.ts', line: 1, endLine: 10 }] },
      flows: [],
      validationWarnings: []
    }

    const model = legacyC4ToScryModel(legacy)

    expect(model).toEqual({
      version: '0.3',
      nodes: [
        {
          id: 'api',
          kind: 'system',
          name: 'API',
          external: false,
          technology: 'Node',
          description: 'Serves requests',
          properties: [{ label: 'Port', description: 'HTTP port' }]
        }
      ],
      links: [{ id: 'edge-api-db', src: 'api', dst: 'db', label: 'uses', method: 'SQL' }],
      groups: [{ id: 'group-1', name: 'Runtime', memberIds: ['api'] }],
      sourceMap: { api: [{ pattern: 'src/api.ts', line: 1, endLine: 10 }] },
      boundaries: {}
    })
    expect(JSON.stringify(model)).not.toContain('position')
    expect(JSON.stringify(model)).not.toContain('_needsLayout')
    expect(JSON.stringify(model)).not.toContain('flows')
  })
})
