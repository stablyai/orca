import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readGolden } from './golden-recording'
import { OBSERVATION_FIELDS } from './golden-value-pool'
import type { Observation } from './recording-scenario'
import type { RecordedValue } from './recording-values'

const root = resolve(import.meta.dirname, '../../../..')
const directory =
  process.env.RPC_FOUNDATION_GOLDENS ?? resolve(root, 'mobile/rpc-foundation/goldens')

/** `captureValue`'s two refusals. Neither is ever product behaviour. */
const PROJECTION_REFUSALS = [
  'Unsupported observation',
  'Observation requires an explicit projection'
]

function refusalText(value: RecordedValue): boolean {
  if (typeof value === 'string') {
    return PROJECTION_REFUSALS.some((refusal) => value.includes(refusal))
  }
  if (Array.isArray(value)) {
    return value.some(refusalText)
  }
  return typeof value === 'object' && value !== null && Object.values(value).some(refusalText)
}

function failures(at: string, observation: Observation): string[] {
  const found: string[] = []
  for (const field of OBSERVATION_FIELDS) {
    if (refusalText(observation[field])) {
      found.push(`${at}.${field}: recorder refused to project a value`)
    }
  }
  return found
}

// Projection refusals can be captured as data and re-recorded green; reject those while allowing real detached product failures.
describe('recorder failures never reach a golden', () => {
  it('records no refused projection in any observation field', () => {
    const ids = readdirSync(directory)
      .filter((file) => file.endsWith('.json'))
      .map((file) => file.replace(/\.json$/, ''))

    // Seed a captured refusal to prove absence checking detects the real failure shape.
    const seeded: Observation = {
      sender: [],
      payloads: [],
      settlements: { fetch: { status: 'pending' } },
      state: { fetched: 'Observation requires an explicit projection for non-plain objects' },
      effects: [
        { name: 'unhandled-rejection', value: { message: 'Unsupported observation: function' } }
      ]
    }
    expect(failures('seeded', seeded)).toEqual([
      'seeded.state: recorder refused to project a value',
      'seeded.effects: recorder refused to project a value'
    ])

    let checkpoints = 0
    const found = ids.flatMap((id) =>
      readGolden(directory, id).recording.checkpoints.flatMap((checkpoint) => {
        checkpoints++
        return failures(`${id}/${checkpoint.id}`, checkpoint.observation)
      })
    )
    expect(found).toEqual([])
    expect(ids.length).toBeGreaterThan(0)
    expect(checkpoints).toBeGreaterThan(ids.length)
  })
})
