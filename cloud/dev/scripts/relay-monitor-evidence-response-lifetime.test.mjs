import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  createEvidenceManifest,
  verifyMutationEvidence
} from './relay-monitor-evidence.mjs'

const now = Date.parse('2026-07-28T12:00:00.000Z')
const provenance = [
  '--incident-id', 'relay-123', '--run-id', '123', '--run-attempt', '1',
  '--commit-sha', 'a'.repeat(40), '--mode', 'dry-run'
]
const selector = {
  generation: 2,
  membership: { existingOnly: ['c1'], migrationOnly: ['c2'], general: ['c3'] }
}

async function evidenceDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'relay-monitor-response-'))
  await writeFile(join(directory, 'relay-123.state.json'), `${JSON.stringify({
    schemaVersion: 4,
    incidentId: 'relay-123',
    environment: 'production',
    preDrainDryRun: true,
    migrationPolicy: 'strict',
    recoverySourceCellId: null,
    capacityCellId: null,
    startedAt: new Date(now - 17 * 60_000).toISOString(),
    durationMinutes: 15,
    intervalMs: 60_000,
    sampleCount: 16,
    windowStartedAt: new Date(now - 16 * 60_000).toISOString(),
    lastSampleAt: new Date(now - 60_007).toISOString(),
    completedAt: new Date(now - 60_000).toISOString(),
    frozenAt: null,
    expectedSelector: selector
  })}\n`)
  await createEvidenceManifest(['--directory', directory, ...provenance])
  return directory
}

function streamingResponse(active, status) {
  let controller
  const response = new Response(new ReadableStream({
    start(stream) {
      controller = stream
      active.add(stream)
      stream.enqueue(new TextEncoder().encode('unused response bytes'))
    },
    cancel() {
      active.delete(controller)
    }
  }), { status })
  return { response, close: () => controller.close() }
}

function mutationArgs(directory) {
  return [
    '--directory', directory, ...provenance,
    '--mutation-mode', 'execute', '--source-cell-id', 'c1',
    '--director-origin', 'https://relay.example'
  ]
}

for (const status of [401, 403, 500, 503]) {
  test(`releases streaming selector response ${status}`, async (context) => {
    const directory = await evidenceDirectory()
    const active = new Set()
    context.after(async () => {
      for (const stream of active) stream.cancel()
      await rm(directory, { recursive: true, force: true })
    })
    for (let cycle = 0; cycle < 10; cycle++) {
      const body = streamingResponse(active, status)
      await assert.rejects(
        verifyMutationEvidence(
          mutationArgs(directory),
          { ORCA_RELAY_ADMIN_ID_TOKEN: 'aaa.bbb.ccc' },
          async () => body.response,
          () => now
        ),
        /live selector verification failed/
      )
      assert.equal(active.size, 0)
    }
  })
}

test('preserves selector failure when body cancellation rejects', async (context) => {
  const directory = await evidenceDirectory()
  context.after(() => rm(directory, { recursive: true, force: true }))
  let canceled = 0
  await assert.rejects(
    verifyMutationEvidence(
      mutationArgs(directory),
      { ORCA_RELAY_ADMIN_ID_TOKEN: 'aaa.bbb.ccc' },
      async () => ({
        ok: false,
        status: 403,
        body: {
          cancel: async () => {
            canceled++
            throw new Error('cancel failed')
          }
        }
      }),
      () => now
    ),
    /live selector verification failed/
  )
  assert.equal(canceled, 1)
})
