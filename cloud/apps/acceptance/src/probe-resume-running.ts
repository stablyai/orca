// Repro for F1: POST resume on a sandbox that is already running (expected: fast, idempotent).
//   tsx src/probe-resume-running.ts
import { control } from './clients'

const who = { sub: 'w9-probe' }
const c = await control.as(who, 'POST', '/v1/sandboxes', { workspaceId: 'w9-probe-resume', machineSize: 'standard' })
console.log('create', c.status, c.ms)
const id = c.body?.sandbox?.id
try {
  const r = await control.as(who, 'POST', `/v1/sandboxes/${id}/resume`)
  console.log('resume-while-running', r.status, r.ms, JSON.stringify(r.body).slice(0, 120))
  const w = await control.as(who, 'POST', `/v1/sandboxes/${id}/wake?wait=30s`)
  console.log('wake-while-running', w.status, w.ms, w.body?.state)
} finally {
  console.log('destroy', (await control.as(who, 'DELETE', `/v1/sandboxes/${id}`)).status)
}
