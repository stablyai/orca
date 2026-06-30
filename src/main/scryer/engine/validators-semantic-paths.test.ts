import { describe, expect, it } from 'vitest'
import { errorDetailSchemas, validationFindingCodeSchema } from './schemas'
import { semanticPath, parseSemanticPath } from './semantic-paths'
import {
  anchorRangeWarningFinding,
  coverageGapFinding,
  coverageOverlapFinding,
  invalidDriftMarkerTransitionFinding,
  linkViolation,
  validateModelStructure
} from './validators'
import type { ScryModel } from './model'

describe('Scryer validators and semantic paths', () => {
  it('formats and parses stable semantic paths', () => {
    const path = semanticPath.nodeResponsibility('api gateway', 'resp:1', 'statement')

    expect(path).toBe('node:api%20gateway.responsibility:resp%3A1.statement')
    expect(parseSemanticPath(path)).toEqual({
      kind: 'node_responsibility',
      nodeId: 'api gateway',
      responsibilityId: 'resp:1',
      field: 'statement'
    })
    expect(parseSemanticPath(semanticPath.sourceMapNode('api'))).toEqual({
      kind: 'sourceMap_node',
      nodeId: 'api'
    })
  })

  it('emits structured findings with schema-valid details', () => {
    const model: ScryModel = {
      version: '0.3',
      nodes: [
        {
          id: 'api',
          kind: 'component',
          name: 'API',
          external: true,
          description: 'x'.repeat(501),
          responsibilities: [{ id: 'resp-1', statement: '' }]
        },
        { id: 'api', kind: 'system', name: 'Duplicate API' },
        { id: 'symbol', kind: 'symbol', name: 'not valid symbol' }
      ],
      links: [
        { id: 'link-1', src: 'api', dst: 'missing', label: 'calls' },
        { id: 'link-self', src: 'api', dst: 'api', label: 'self' }
      ],
      groups: [{ id: 'group-1', name: 'Mixed', memberIds: ['api', 'missing'] }],
      sourceMap: { orphan: [{ pattern: 'src/orphan.ts' }] },
      boundaries: { orphan: [{ pattern: 'src/orphan/**' }] }
    }

    const findings = validateModelStructure(model)
    findings.push(
      coverageGapFinding('src/unmapped', 'package.json'),
      coverageOverlapFinding('src/shared', ['api', 'worker']),
      anchorRangeWarningFinding({ responsibilityId: 'resp-1', pattern: 'src/api.ts' }),
      invalidDriftMarkerTransitionFinding({
        entity: 'responsibility',
        id: 'resp-1',
        reason: 'vagrant_move'
      })
    )
    const codes = new Set(findings.map((finding) => finding.code))

    expect([...codes].sort()).toEqual([...validationFindingCodeSchema.options].sort())
    expect([...codes]).toEqual(
      expect.arrayContaining([
        'duplicate_id',
        'invalid_hierarchy',
        'invalid_external',
        'description_too_long',
        'empty_responsibility',
        'invalid_symbol_name',
        'empty_symbol',
        'missing_reference',
        'illegal_link',
        'invalid_group',
        'unknown_source_map_target',
        'unknown_boundary_target'
      ])
    )
    for (const finding of findings) {
      expect(validationFindingCodeSchema.safeParse(finding.code).success).toBe(true)
      expect(finding.path).toEqual(expect.any(String))
      if (finding.details) {
        expect(
          errorDetailSchemas.validation_failed.safeParse({ findings: [finding] }).success
        ).toBe(true)
      }
    }
  })

  it('classifies link legality failures', () => {
    const model: ScryModel = {
      version: '0.3',
      nodes: [
        { id: 'shop', kind: 'system', name: 'Shop' },
        { id: 'api', kind: 'container', name: 'API', parentId: 'shop' },
        { id: 'web', kind: 'container', name: 'Web', parentId: 'shop' },
        { id: 'other', kind: 'system', name: 'Other' },
        { id: 'db', kind: 'container', name: 'DB', parentId: 'other' }
      ],
      links: [{ id: 'link-web-api', src: 'web', dst: 'api', label: 'calls' }],
      groups: [],
      sourceMap: {},
      boundaries: {}
    }

    expect(linkViolation(model, 'api', 'api')).toMatchObject({ reason: 'self_link' })
    expect(linkViolation(model, 'shop', 'api')).toMatchObject({
      reason: 'ancestor_descendant'
    })
    expect(linkViolation(model, 'api', 'db')).toMatchObject({
      reason: 'same_level_reference'
    })
    expect(linkViolation(model, 'web', 'api')).toMatchObject({ reason: 'duplicate_link' })
  })
})
