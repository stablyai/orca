import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FreebuffStatusProjection } from './freebuff-status-projection'
import { createAgentStatusOscProcessor } from '../shared/agent-status-osc'

const transcript = readFileSync(
  join(import.meta.dirname, '../main/runtime/__fixtures__/freebuff-lifecycle.txt'),
  'utf8'
)

describe('Freebuff relay status projection', () => {
  it.each([1, 137, 4096, transcript.length])(
    'publishes host-observed states with %i-character PTY chunks',
    (size) => {
      const projection = new FreebuffStatusProjection(120, 40)
      const parse = createAgentStatusOscProcessor()
      const states: string[] = []
      try {
        for (let index = 0; index < transcript.length; index += size) {
          const raw = transcript.slice(index, index + size)
          const projected = projection.project(raw)
          // oxlint-disable-next-line no-control-regex -- Terminal protocol delimiters contain ESC and BEL.
          expect(projected.replace(/\x1b\]9999;[^\x07]*\x07/g, '')).toBe(raw)
          for (const payload of parse(projected).payloads) {
            expect(payload.agentType).toBe('freebuff')
            if (states.at(-1) !== payload.state) {
              states.push(payload.state)
            }
          }
        }
        expect(states).toContain('working')
        expect(states).toContain('waiting')
        expect(states.at(-1)).toBe('done')
        projection.resize(90, 30)
        projection.dispose()
        expect(projection.project('later output')).toBe('later output')
      } finally {
        projection.dispose()
      }
    }
  )
})
