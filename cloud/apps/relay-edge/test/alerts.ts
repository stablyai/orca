// Unit checks for src/alerts.ts rules and edge-triggering, with a stubbed Analytics Engine.
//   npx tsx test/alerts.ts
import { evaluate } from '../src/alerts'

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, detail = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`)
}

const base = { phone_open: 1000, control_active: 1000, refuse_4401: 0, refuse_busy: 0, control_close: 500, db_ops: 500, db_failures: 0, db_p95_ms: 40, events: 5000 }
const env = { ACCOUNT_ID: 'a', DATASET: 'd', ENVIRONMENT: 'test', AE_READ_TOKEN: 't', ALERT_WEBHOOK_URL: 'https://hook', MIN_VOLUME: '200' }

async function run(now: Partial<typeof base>, before: Partial<typeof base>, minute = 17): Promise<{ fired: string[]; posts: string[] }> {
  const posts: string[] = []
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    if (url === env.ALERT_WEBHOOK_URL) {
      posts.push(JSON.parse(String(init.body)).text)
      return new Response('ok')
    }
    const sql = String(init.body)
    const row = sql.includes("INTERVAL '32' MINUTE") ? { ...base, ...before } : { ...base, ...now }
    return Response.json({ data: [sql.includes('db_p95_ms') && !sql.includes('sumIf') ? { db_p95_ms: row.db_p95_ms } : row] })
  }) as typeof fetch
  const fired = await evaluate(env, Date.UTC(2026, 10, 6, 10, minute))
  return { fired, posts }
}

let r = await run({}, {})
check('healthy: nothing fires', r.fired.length === 0, JSON.stringify(r.fired))
r = await run({ refuse_4401: 20 }, {})
check('4401 at 1% of hellos fires once', r.fired.length === 1 && r.fired[0].startsWith('FIRING auth-refusals') && r.posts.length === 1, r.fired.join())
r = await run({ refuse_4401: 20 }, { refuse_4401: 20 })
check('still breaching: quiet between hourly reminders', r.fired.length === 0)
r = await run({ refuse_4401: 20 }, { refuse_4401: 20 }, 2)
check('still breaching: hourly reminder', r.fired[0]?.startsWith('STILL FIRING auth-refusals') === true, r.fired.join())
r = await run({ phone_open: 50, control_active: 50, refuse_4401: 20 }, {})
check('low volume: ratio rules stay quiet', r.fired.length === 0, r.fired.join())
r = await run({ db_failures: 10 }, {})
check('database failures 2% fires', r.fired.some((f) => f.includes('database')), r.fired.join())
r = await run({ db_p95_ms: 450 }, {})
check('database p95 450 ms fires', r.fired.some((f) => f.includes('database')), r.fired.join())
r = await run({ refuse_busy: 120 }, {})
check('4429/4503 at 6% fires', r.fired.some((f) => f.includes('busy-refusals')), r.fired.join())
r = await run({ control_close: 4000 }, {})
check('mass drop fires', r.fired.some((f) => f.includes('mass-drop')), r.fired.join())
r = await run({ events: 0, phone_open: 0, control_active: 0, control_close: 0, db_ops: 0 }, {})
check('silence after traffic fires', r.fired.some((f) => f.includes('silent')), r.fired.join())
r = await run({ events: 0, phone_open: 0, control_active: 0, control_close: 0, db_ops: 0 }, { events: 0, phone_open: 0, control_active: 0, control_close: 0, db_ops: 0 })
check('idle environment stays quiet', r.fired.length === 0, r.fired.join())
globalThis.fetch = (async (url: string) => (url === env.ALERT_WEBHOOK_URL ? new Response('ok') : new Response('no', { status: 403 }))) as typeof fetch
const broken = await evaluate(env, Date.UTC(2026, 10, 6, 10, 17))
check('unreadable metrics alert', broken[0]?.includes('cannot read metrics') === true, broken.join())
const unset = await evaluate({ ...env, AE_READ_TOKEN: '' }, 0)
check('no secrets: skip quietly', unset.length === 0)
console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail ? 1 : 0)
