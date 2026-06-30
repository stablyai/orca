import { describe, expect, it } from 'vitest'
import { selectModelQuery, selectModelRead, selectModelSearch } from './read-selector'
import type { ScryModel } from './model'

function fixtureModel(): ScryModel {
  return {
    version: '0.3',
    nodes: [
      { id: 'customer', kind: 'person', name: 'Customer', description: 'Uses the storefront' },
      { id: 'shop', kind: 'system', name: 'Shop', description: 'Commerce platform' },
      { id: 'auth', kind: 'system', name: 'Auth0', external: true },
      {
        id: 'web',
        kind: 'container',
        name: 'Web App',
        parentId: 'shop',
        technology: 'React',
        responsibilities: [{ id: 'resp-web', statement: 'Renders storefront login' }]
      },
      {
        id: 'api',
        kind: 'container',
        name: 'API',
        parentId: 'shop',
        technology: 'Node.js',
        responsibilities: [{ id: 'resp-api', statement: 'Validates checkout requests' }]
      },
      {
        id: 'frontend',
        kind: 'component',
        name: 'Frontend Shell',
        parentId: 'web',
        properties: [{ label: 'theme', description: 'Selected storefront theme' }]
      },
      {
        id: 'loginForm',
        kind: 'symbol',
        name: 'LoginForm',
        parentId: 'frontend',
        visual: true,
        responsibilities: [{ id: 'resp-login', statement: 'Handles login form submit' }],
        properties: [{ label: 'email', description: 'Customer email address' }]
      },
      { id: 'emptySymbol', kind: 'symbol', name: 'EmptyAdapter', parentId: 'frontend' }
    ],
    links: [
      { id: 'link-customer-web', src: 'customer', dst: 'web', label: 'uses' },
      { id: 'link-web-api', src: 'web', dst: 'api', label: 'calls' },
      { id: 'link-api-auth', src: 'api', dst: 'auth', label: 'delegates auth' },
      { id: 'link-frontend-api', src: 'frontend', dst: 'api', label: 'submits login' }
    ],
    groups: [{ id: 'runtime', name: 'Runtime', memberIds: ['web', 'api'] }],
    sourceMap: {
      'resp-web': [{ pattern: 'src/web.tsx', symbol: 'WebApp' }],
      'resp-login': [{ pattern: 'src/LoginForm.tsx', symbol: 'LoginForm' }],
      loginForm: [{ pattern: 'src/LoginForm.tsx' }]
    },
    boundaries: {
      web: [{ pattern: 'src/web/**' }],
      api: [{ pattern: 'src/api/**' }]
    }
  }
}

describe('ScryerReadSelector', () => {
  it('returns an exact overview navigation payload', () => {
    const result = selectModelRead(fixtureModel(), { layer: 'plan' })

    expect(result).toEqual({
      ok: true,
      result: {
        view: 'overview',
        layer: 'plan',
        version: '0.3',
        nodeCount: 8,
        linkCount: 4,
        groupCount: 1,
        truncated: false,
        overview: [
          {
            id: 'customer',
            kind: 'person',
            name: 'Customer',
            path: 'Customer',
            depth: 0,
            childCount: 0,
            directSymbolCount: 0,
            responsibilityCount: 0,
            propertyCount: 0,
            groupCount: 0,
            hasSourceAnchors: false,
            hasBoundaries: false,
            hasExternalLinks: true,
            hiddenSymbolDescendants: false,
            hasChildren: false,
            description: 'Uses the storefront'
          },
          {
            id: 'shop',
            kind: 'system',
            name: 'Shop',
            path: 'Shop',
            depth: 0,
            childCount: 2,
            directSymbolCount: 0,
            responsibilityCount: 0,
            propertyCount: 0,
            groupCount: 0,
            hasSourceAnchors: false,
            hasBoundaries: false,
            hasExternalLinks: false,
            hiddenSymbolDescendants: true,
            hasChildren: true,
            description: 'Commerce platform'
          },
          {
            id: 'auth',
            kind: 'system',
            name: 'Auth0',
            path: 'Auth0',
            depth: 0,
            childCount: 0,
            directSymbolCount: 0,
            responsibilityCount: 0,
            propertyCount: 0,
            groupCount: 0,
            hasSourceAnchors: false,
            hasBoundaries: false,
            hasExternalLinks: true,
            hiddenSymbolDescendants: false,
            hasChildren: false,
            external: true
          },
          {
            id: 'web',
            kind: 'container',
            name: 'Web App',
            path: 'Shop / Web App',
            depth: 1,
            childCount: 1,
            directSymbolCount: 0,
            responsibilityCount: 1,
            propertyCount: 0,
            groupCount: 1,
            hasSourceAnchors: true,
            hasBoundaries: true,
            hasExternalLinks: true,
            hiddenSymbolDescendants: true,
            hasChildren: true,
            parentId: 'shop',
            technology: 'React'
          },
          {
            id: 'api',
            kind: 'container',
            name: 'API',
            path: 'Shop / API',
            depth: 1,
            childCount: 0,
            directSymbolCount: 0,
            responsibilityCount: 1,
            propertyCount: 0,
            groupCount: 1,
            hasSourceAnchors: false,
            hasBoundaries: true,
            hasExternalLinks: true,
            hiddenSymbolDescendants: false,
            hasChildren: false,
            parentId: 'shop',
            technology: 'Node.js'
          },
          {
            id: 'frontend',
            kind: 'component',
            name: 'Frontend Shell',
            path: 'Shop / Web App / Frontend Shell',
            depth: 2,
            childCount: 2,
            directSymbolCount: 2,
            responsibilityCount: 0,
            propertyCount: 1,
            groupCount: 0,
            hasSourceAnchors: false,
            hasBoundaries: false,
            hasExternalLinks: true,
            hiddenSymbolDescendants: true,
            hasChildren: true,
            parentId: 'web'
          }
        ],
        recommendedNextReads: [
          {
            operationId: 'scryer.model.read',
            input: { view: 'subtree', node: 'customer', layer: 'plan' },
            reason: 'Drill into a visible overview node for responsibilities, links, and sources.'
          },
          {
            operationId: 'scryer.model.search',
            input: { query: '<text>', layer: 'plan' },
            reason: 'Locate a concept when the node id is unknown.'
          },
          {
            operationId: 'scryer.model.query',
            input: { where: [{ field: 'kind', op: 'eq', value: 'component' }], layer: 'plan' },
            reason: 'Find model nodes by structural shape.'
          },
          {
            operationId: 'scryer.model.read',
            input: { view: 'full', layer: 'plan' },
            reason:
              'Use explicit full reads only for export, debug, fixtures, or broad restructuring.'
          }
        ]
      }
    })
  })

  it('returns exact subtree and explicit full payloads', () => {
    const model = fixtureModel()
    const subtree = selectModelRead(model, { node: 'web' })
    const full = selectModelRead(model, { view: 'full', layer: 'committed' })

    expect(subtree).toMatchObject({
      ok: true,
      result: {
        view: 'subtree',
        layer: 'plan',
        node: expect.objectContaining({ id: 'web', path: 'Shop / Web App' }),
        descendants: [
          expect.objectContaining({ id: 'frontend' }),
          expect.objectContaining({ id: 'loginForm' }),
          expect.objectContaining({ id: 'emptySymbol' })
        ],
        internalLinks: [],
        externalLinks: [
          { id: 'link-customer-web', src: 'customer', dst: 'web', label: 'uses' },
          { id: 'link-web-api', src: 'web', dst: 'api', label: 'calls' },
          { id: 'link-frontend-api', src: 'frontend', dst: 'api', label: 'submits login' }
        ],
        contextNodes: [
          expect.objectContaining({ id: 'customer', path: 'Customer' }),
          expect.objectContaining({ id: 'api', path: 'Shop / API' })
        ],
        referencesForChildren: [
          expect.objectContaining({ id: 'customer', direction: 'incoming', label: 'uses' }),
          expect.objectContaining({ id: 'api', direction: 'outgoing', label: 'calls' })
        ],
        sourceMap: {
          'resp-web': [{ pattern: 'src/web.tsx', symbol: 'WebApp' }],
          'resp-login': [{ pattern: 'src/LoginForm.tsx', symbol: 'LoginForm' }],
          loginForm: [{ pattern: 'src/LoginForm.tsx' }]
        },
        boundaries: { web: [{ pattern: 'src/web/**' }] },
        degraded: false,
        truncated: false,
        recommendedNextReads: expect.any(Array)
      }
    })
    expect(full).toEqual({
      ok: true,
      result: {
        view: 'full',
        layer: 'committed',
        version: '0.3',
        nodeCount: 8,
        linkCount: 4,
        groupCount: 1,
        model
      }
    })
  })

  it('searches with AND terms, exact/fuzzy metadata, model-order ties, and a cap', () => {
    const search = selectModelSearch(fixtureModel(), { query: 'login form' })
    const stress = selectModelSearch(
      {
        version: '0.3',
        nodes: Array.from({ length: 51 }, (_, index) => ({
          id: `node-${index}`,
          kind: 'component' as const,
          name: `Auth Component ${index}`
        })),
        links: [],
        groups: [],
        sourceMap: {},
        boundaries: {}
      },
      { query: 'auth' }
    )

    expect(search).toMatchObject({
      ok: true,
      result: {
        query: 'login form',
        resultCount: 1,
        truncated: false,
        hits: [
          expect.objectContaining({
            id: 'loginForm',
            matched: expect.arrayContaining([
              { field: 'name', value: 'LoginForm', match: 'exact', score: 1 },
              {
                field: 'responsibility',
                value: 'Handles login form submit',
                match: 'exact',
                score: 1
              }
            ])
          })
        ]
      }
    })
    expect(stress).toMatchObject({
      ok: true,
      result: {
        resultCount: 50,
        truncated: true,
        hits: expect.arrayContaining([
          expect.objectContaining({ id: 'node-0' }),
          expect.objectContaining({ id: 'node-1' })
        ])
      }
    })
  })

  it('queries only the documented predicate surface and preserves empty-symbol semantics', () => {
    const emptySymbols = selectModelQuery(fixtureModel(), {
      where: [
        { field: 'kind', op: 'eq', value: 'symbol' },
        { field: 'empty', op: 'eq', value: true }
      ]
    })
    const badField = selectModelQuery(fixtureModel(), {
      where: [{ field: 'childrenMissing', op: 'eq', value: 0 }]
    })
    const stress = selectModelQuery(
      {
        version: '0.3',
        nodes: Array.from({ length: 201 }, (_, index) => ({
          id: `symbol-${index}`,
          kind: 'symbol' as const,
          name: `Generated Symbol ${index}`
        })),
        links: [],
        groups: [],
        sourceMap: {},
        boundaries: {}
      },
      { where: [{ field: 'kind', op: 'eq', value: 'symbol' }] }
    )

    expect(emptySymbols).toEqual({
      ok: true,
      result: {
        layer: 'plan',
        resultCount: 1,
        truncated: false,
        hits: [
          {
            id: 'emptySymbol',
            kind: 'symbol',
            name: 'EmptyAdapter',
            path: 'Shop / Web App / Frontend Shell / EmptyAdapter',
            nResp: 0,
            nProps: 0,
            childCount: 0,
            parentId: 'frontend',
            empty: true
          }
        ],
        where: [
          { field: 'kind', op: 'eq', value: 'symbol' },
          { field: 'empty', op: 'eq', value: true }
        ]
      }
    })
    expect(badField).toMatchObject({
      ok: false,
      failure: {
        code: 'invalid_input',
        fieldErrors: [expect.objectContaining({ path: 'where.field' })]
      }
    })
    expect(stress).toMatchObject({
      ok: true,
      result: { resultCount: 200, truncated: true }
    })
  })

  it('degrades oversized subtrees to direct-child skeletons', () => {
    const model: ScryModel = {
      version: '0.3',
      nodes: [
        { id: 'root', kind: 'system', name: 'Root' },
        ...Array.from({ length: 80 }, (_, index) => ({
          id: `child-${index}`,
          kind: 'container' as const,
          name: `Child ${index}`,
          parentId: 'root',
          description: 'x'.repeat(1000)
        }))
      ],
      links: [],
      groups: [],
      sourceMap: {},
      boundaries: {}
    }

    const result = selectModelRead(model, { node: 'root' })

    expect(result).toMatchObject({
      ok: true,
      result: {
        view: 'subtree',
        degraded: true,
        truncated: true,
        descendants: [],
        children: expect.arrayContaining([
          expect.objectContaining({ id: 'child-0' }),
          expect.objectContaining({ id: 'child-1' })
        ]),
        recommendedNextReads: expect.arrayContaining([
          expect.objectContaining({
            operationId: 'scryer.model.read',
            input: { view: 'subtree', node: 'child-0', layer: 'plan' }
          })
        ])
      }
    })
  })
})
