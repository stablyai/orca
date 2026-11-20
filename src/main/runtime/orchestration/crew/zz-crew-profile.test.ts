import { it } from 'vitest'
import { fixture } from './crew-read-model.test-fixture'
import { seedLegacyCrewLoad, LEGACY_COORDINATOR } from './legacy-crew-load.test-fixture'
import { createCrewHostDerivation } from './crew-host-derivation'
import { buildCrewSnapshot } from './crew-party-snapshot'
import { readCrewAssignments } from './crew-query'

it('profiles', () => {
  const f = fixture()
  seedLegacyCrewLoad(f.db)
  const parties = [LEGACY_COORDINATOR, 'term_coord', 'term_worker', 'term_lw1', 'term_lw2', 'term_c0', 'term_c1', 'term_o0_1', 'term_c2', 'run:run_legacy_adopted']
  const sqlTime = new Map<string, { n: number; ms: number }>()
  const prepare = f.db.db.prepare.bind(f.db.db)
  f.db.db.prepare = (sql: string) => {
    const stmt = prepare(sql)
    const key = sql.replace(/\s+/g, ' ').slice(0, 90)
    const wrap = (name: 'all' | 'get' | 'run') => {
      const orig = (stmt as any)[name].bind(stmt)
      ;(stmt as any)[name] = (...args: unknown[]) => {
        const t = performance.now()
        try { return orig(...args) } finally {
          const e = sqlTime.get(key) ?? { n: 0, ms: 0 }
          e.n++; e.ms += performance.now() - t; sqlTime.set(key, e)
        }
      }
    }
    wrap('all'); wrap('get'); wrap('run')
    return stmt
  }
  for (let round = 0; round < 3; round++) {
    sqlTime.clear()
    let t = performance.now()
    const a = readCrewAssignments(f.db, Date.now())
    const tAssign = performance.now() - t
    t = performance.now()
    const host = createCrewHostDerivation(f.deps)
    const tHost = performance.now() - t
    const per: string[] = []
    for (const p of parties) {
      const s = performance.now()
      buildCrewSnapshot(p, { ...host.deps, now: Date.now() }, host)
      per.push(`${p}=${(performance.now() - s).toFixed(1)}`)
    }
    const per2: string[] = []
    for (const p of parties) {
      const s = performance.now()
      buildCrewSnapshot(p, { ...host.deps, now: Date.now() }, host)
      per2.push(`${p}=${(performance.now() - s).toFixed(1)}`)
    }
    console.log(`ROUND ${round} assignments=${a.length} readAssign=${tAssign.toFixed(1)}ms host=${tHost.toFixed(1)}ms\n first: ${per.join(' ')}\n warm: ${per2.join(' ')}`)
    const top = [...sqlTime].sort((x, y) => y[1].ms - x[1].ms).slice(0, 12)
    for (const [k, v] of top) console.log(`  ${v.ms.toFixed(1)}ms x${v.n} ${k}`)
  }
}, 120_000)
