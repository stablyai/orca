import { mkdtemp, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { assertParityEnvelopeShape, loadParityFixture, scrubParityValue } from './parity-fixtures'

describe('Scryer parity fixtures', () => {
  it('loads only zod-validated parity metadata', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orca-scryer-parity-'))
    const casePath = join(dir, 'case.json')
    await writeFile(
      casePath,
      JSON.stringify(
        {
          operationId: 'scryer.link.add',
          upstreamCommit: 'a1b2c3d4',
          upstreamAnchors: ['links.rs::add_links', 'validate.rs::link_violation'],
          input: { links: [{ src: 'web', dst: 'api', label: 'calls' }] },
          context: {},
          expected: 'success',
          orcaDifferenceReason: 'structured envelope replaces MCP Content::text output'
        },
        null,
        2
      )
    )

    await expect(loadParityFixture(casePath)).resolves.toMatchObject({
      operationId: 'scryer.link.add',
      expected: 'success'
    })
  })

  it('requires fixture expectation to match the operation envelope', () => {
    expect(() =>
      assertParityEnvelopeShape(
        {
          operationId: 'scryer.link.add',
          upstreamCommit: 'a1b2c3d4',
          upstreamAnchors: ['links.rs::add_links'],
          input: {},
          context: {},
          expected: 'success',
          orcaDifferenceReason: 'structured envelope replaces MCP text'
        },
        {
          ok: false,
          operationId: 'scryer.link.add',
          requestId: 'req-1',
          error: { code: 'internal_error', message: 'bad' }
        }
      )
    ).toThrow('expected ok:true')
  })

  it('scrubs request ids, timestamps, temp paths, and absolute paths for golden comparison', () => {
    expect(
      scrubParityValue({
        requestId: 'req-abc',
        createdAt: '2026-06-24T12:00:00.000Z',
        tempPath: '/tmp/orca/file',
        path: '/home/example/project/.scryer/model.scry'
      })
    ).toEqual({
      requestId: '<requestId>',
      createdAt: '<timestamp>',
      tempPath: '<tmp-path>',
      path: '<abs-path>'
    })
  })
})
