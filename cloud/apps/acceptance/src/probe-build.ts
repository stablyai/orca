// Debug: minimal environment build, streams events for a few minutes, then deletes the environment.
//   tsx src/probe-build.ts [script]
import { sandboxToken } from './tokens'
import { control } from './clients'
import { config } from './env'

const owner = { sub: 'w9-owner', org: 'w9-eval-team', orgRole: 'owner' as const }
const env = await control.as(owner, 'POST', '/v1/environments', { name: `w9-probe-${Date.now() % 100000}`, repos: [{ url: config.testRepo }], installScript: process.argv[2] ?? 'echo hello-build' })
const envId = env.body?.environment?.id
console.log('env', env.status, envId)
try {
  const b = await control.as(owner, 'POST', `/v1/environments/${envId}/builds`)
  const id = b.body?.build?.id
  console.log('build', b.status, id, b.body?.build?.status)
  if (process.argv[3] === 'poll') {
    const t0 = Date.now()
    let s: any = null
    while (Date.now() - t0 < 240_000) {
      s = (await control.as(owner, 'GET', `/v1/environments/${envId}/builds/${id}`)).body?.build
      console.log(Math.round((Date.now() - t0) / 1000), s?.status, s?.logBytes)
      if (['succeeded', 'failed', 'canceled'].includes(s?.status)) break
      await new Promise((r) => setTimeout(r, 10_000))
    }
    process.exitCode = 0
  }
  const ctl = new AbortController()
  setTimeout(() => ctl.abort(), 240_000)
  const r = await fetch(`${config.controlPlaneUrl}/v1/environments/${envId}/builds/${id}/events`, { headers: { authorization: `Bearer ${await sandboxToken(owner)}` }, signal: ctl.signal }).catch((e) => e)
  if (r instanceof Response && r.body) {
    const t0 = Date.now()
    const dec = new TextDecoder()
    try {
      for await (const chunk of r.body as any) {
        for (const line of dec.decode(chunk).split('\n').filter(Boolean)) {
          const e = JSON.parse(line)
          console.log(Math.round((Date.now() - t0) / 1000), e.type, e.type === 'log' ? String(e.text ?? e.line ?? JSON.stringify(e)).slice(0, 160) : JSON.stringify(e.build ?? e).slice(0, 200))
        }
      }
    } catch (e) {
      console.log('stream ended', String(e).slice(0, 80))
    }
  } else {
    console.log('events', r instanceof Response ? r.status : String(r))
  }
  const final = await control.as(owner, 'GET', `/v1/environments/${envId}/builds/${id}`)
  console.log('final', JSON.stringify(final.body?.build).slice(0, 600))
} finally {
  console.log('delete', (await control.as(owner, 'DELETE', `/v1/environments/${envId}`)).status)
}
