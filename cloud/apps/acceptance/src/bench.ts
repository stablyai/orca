// Benchmarks (n >= 10 each) on real Vercel sandboxes through the dev control plane.
//   create.api        POST /v1/sandboxes (golden snapshot + repo clone + orcad ready)
//   create.usable     create.api + the user's client connects (orca CLI E2EE handshake, status ok)
//   create.firstEcho  create.usable + repo add + PTY open + typed command echoed
//   wake.api          POST resume on a slept sandbox (boot from snapshot + orcad ready)
//   wake.firstEcho    wake.api + reconnect + PTY open + typed command echoed ("wake -> first keystroke")
//   suspend.api       POST suspend (drain orcad + stop + snapshot)
//   rollover.gap      POST rollover (drain, stop, boot, orcad ready): the time agents are offline
import { config } from './env'
import type { Ctx } from './context'
import { openTerminal, orca, typeAndSee } from './orca-cli'

export const EARLIER: Record<string, string> = {
  'create.api': 'Pro, 2026-11-09: 4.1-5.4 s (n=3 in-process), 5.1 s via dev Worker',
  'create.usable': 'Desktop dogfood 2026-11-09: create -> ready in app 8-12 s',
  'wake.api': 'Pro 2026-11-09: resume -> ready 6.0 s (n=1); Hobby 2 vCPU: 4.3-5.1 s',
  'suspend.api': 'Pro 2026-11-09: drain + stop 7.6 s (n=1); Hobby stop 2.2 s',
  'rollover.gap': 'Pro 2026-11-09: 12.2 s via dev Worker, 17.3 s at shortened cap'
}
export const CONDUCTOR: Record<string, string> = {
  'create.api': '0.80: "1.5-3x faster sandbox start" (no absolute number published)',
  'create.usable': 'not published',
  'wake.firstEcho': 'not published; wake on open, files kept, processes lost',
  'rollover.gap': 'no rollover: hard stop at 23h50m, manual wake + resend turn',
  'suspend.api': 'not published (20 min idle sleep)',
  'port.forward': '0.83 auto port forwarding; latency not published',
  'share.coldLoad': '0.84.1 share links; latency not published'
}

async function firstEcho(code: string, root: string, kind: 'git' | 'folder') {
  const t = await openTerminal(code, root, kind)
  if (!t.handle) {
    return null
  }
  const e = await typeAndSee(code, t.handle, 'echo BENCH_$((7*6))', 'BENCH_42')
  return e.ok ? e : null
}

export async function benchCreate(ctx: Ctx, n: number): Promise<void> {
  const api: number[] = []
  const usable: number[] = []
  const echo: number[] = []
  const errors: string[] = []
  for (let i = 0; i < n; i++) {
    const t0 = performance.now()
    const r = await ctx.sandboxes.create(ctx.solo, { workspaceId: `w9-bench-c${i}`, repo: { url: config.testRepo } })
    if (r.status !== 200) {
      errors.push(`${r.status}:${r.body?.error}:${r.body?.reason ?? ''}`)
      continue
    }
    api.push(r.ms)
    try {
      const st = await orca(r.body.connection.pairingCode, ['status'])
      if (st.ok) {
        usable.push(Math.round(performance.now() - t0))
      }
      const e = await firstEcho(r.body.connection.pairingCode, r.body.connection.projectRoot, 'git')
      if (e) {
        echo.push(Math.round(performance.now() - t0))
      }
    } finally {
      await ctx.sandboxes.destroy(r.body.sandbox.id)
    }
    console.log(`bench create ${i + 1}/${n}: api ${api.at(-1)} usable ${usable.at(-1)} echo ${echo.at(-1)}`)
  }
  ctx.run.bench('create.api', api, errors.length ? `errors: ${errors.join(' ')}` : undefined)
  ctx.run.bench('create.usable', usable)
  ctx.run.bench('create.firstEcho', echo)
}

export async function benchWakeAndRollover(ctx: Ctx, n: number): Promise<void> {
  const r = await ctx.sandboxes.create(ctx.solo, { workspaceId: 'w9-bench-wake' })
  if (r.status !== 200) {
    ctx.run.note(`wake bench: create failed ${r.status}`)
    return
  }
  const id = r.body.sandbox.id
  const wakeApi: number[] = []
  const wakeEcho: number[] = []
  const suspend: number[] = []
  const rollover: number[] = []
  const errors: string[] = []
  try {
    for (let i = 0; i < n; i++) {
      const s = await ctx.sandboxes.suspend(id)
      if (s.status !== 200) {
        errors.push(`suspend ${s.status}`)
        continue
      }
      suspend.push(s.ms)
      const t0 = performance.now()
      const w = await ctx.sandboxes.resume(id)
      if (w.status !== 200) {
        errors.push(`resume ${w.status}:${(w.body as any)?.reason ?? ''}`)
        continue
      }
      wakeApi.push(w.ms)
      const e = await firstEcho(w.body.connection.pairingCode, w.body.connection.projectRoot, 'folder')
      if (e) {
        wakeEcho.push(Math.round(performance.now() - t0))
      }
      console.log(`bench wake ${i + 1}/${n}: suspend ${s.ms} wake ${w.ms} echo ${wakeEcho.at(-1)}`)
    }
    for (let i = 0; i < n; i++) {
      const ro = await ctx.sandboxes.rollover(id)
      if (ro.status !== 200) {
        errors.push(`rollover ${ro.status}:${(ro.body as any)?.reason ?? ''}`)
        continue
      }
      rollover.push(ro.ms)
      console.log(`bench rollover ${i + 1}/${n}: ${ro.ms}`)
    }
  } finally {
    await ctx.sandboxes.destroy(id)
  }
  const note = errors.length ? `errors: ${errors.join(' ')}` : undefined
  ctx.run.bench('suspend.api', suspend, note)
  ctx.run.bench('wake.api', wakeApi, note)
  ctx.run.bench('wake.firstEcho', wakeEcho)
  ctx.run.bench('rollover.gap', rollover, note)
}
