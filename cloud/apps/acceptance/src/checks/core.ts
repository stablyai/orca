// Core platform checks against the deployed dev control plane and real Vercel sandboxes.
import { billing, control, vercelRest } from '../clients'
import { config } from '../env'
import { log, timing, type Check } from '../context'
import { openTerminal, orca, typeAndSee } from '../orca-cli'

/** Login-shell PATH as the user's terminal sees it (the golden image puts tools under /opt/orca). */
const LOGIN = (script: string) => `bash -lc ${JSON.stringify(script)}`

export const coreChecks: Record<string, Check> = {
  'acct.signin': async (ctx) => {
    const list = await control.as(ctx.solo, 'GET', '/v1/sandboxes')
    const bad = await control.raw('GET', '/v1/sandboxes', 'not-a-token')
    const ent = await billing.as(ctx.owner, 'GET', '/v1/billing/entitlements')
    const ok = list.status === 200 && bad.status === 401 && ent.status === 200
    return {
      status: ok ? 'pass' : 'fail',
      detail: `control list ${list.status}, bad token ${bad.status}, billing entitlements ${ent.status} (account ${ent.body?.accountId})`,
      evidence: [log('responses', JSON.stringify({ list: list.status, bad: bad.body, entitlements: { accountId: ent.body?.accountId, status: ent.body?.status } }))]
    }
  },

  'acct.isolation': async (ctx) => {
    const p = await ctx.primary()
    const id = p.sandbox.id
    const get = await control.as(ctx.outsider, 'GET', `/v1/sandboxes/${id}`)
    const del = await control.as(ctx.outsider, 'DELETE', `/v1/sandboxes/${id}`)
    const sus = await control.as(ctx.outsider, 'POST', `/v1/sandboxes/${id}/suspend`)
    const list = await control.as(ctx.outsider, 'GET', '/v1/sandboxes')
    const leaked = (list.body?.sandboxes ?? []).some((s: any) => s.id === id)
    const ok = get.status === 404 && del.status === 404 && sus.status === 404 && !leaked
    return { status: ok ? 'pass' : 'fail', detail: `outsider GET ${get.status}, DELETE ${del.status}, suspend ${sus.status}, in list: ${leaked}` }
  },

  'billing.entitlement-gate': async (ctx) => {
    const ent = await billing.as({ sub: 'w9-noplan', org: `w9-noplan-${ctx.run.file.runId}`, orgRole: 'owner' }, 'GET', '/v1/billing/entitlements')
    const refused = ent.body?.canStartSandbox === false
    return {
      status: refused ? 'partial' : 'fail',
      detail: `no-plan org: canStartSandbox=${ent.body?.canStartSandbox} reason=${ent.body?.reason ?? ent.body?.startBlockedReason ?? '?'}; control-plane side not reachable with dev tokens (dev:* accounts bypass billing by design), covered by unit tests`,
      evidence: [log('entitlements', JSON.stringify(ent.body).slice(0, 1500))]
    }
  },

  'sub.create': async (ctx) => {
    const p = await ctx.primary()
    const ok = p.sandbox.status === 'running' && p.connection.type === 'orca-server' && p.connection.pairingCode.startsWith('orca://pair?')
    return { status: ok ? 'pass' : 'fail', detail: `POST /v1/sandboxes -> ${p.sandbox.status} in ${p.createMs} ms (orcad ready, repo cloned)`, timingsMs: { createReady: p.createMs }, evidence: [timing('create -> orcad ready', p.createMs)] }
  },

  'sub.size': async (ctx) => {
    const p = await ctx.primary()
    const r = await ctx.exec(p.sandbox.session!.id, 'nproc; awk "/MemTotal/{print int(\\$2/1024/1024+0.5)}" /proc/meminfo')
    const [cpus, memGb] = r.stdout.trim().split('\n').map(Number)
    const large = await control.as(ctx.solo, 'POST', '/v1/sandboxes', { workspaceId: 'w9-xl', machineSize: 'xlarge' })
    const ok = cpus === 4 && (memGb ?? 0) >= 7
    return {
      status: ok ? 'pass' : 'fail',
      detail: `standard = ${cpus} vCPU / ${memGb} GB; xlarge refused with ${large.status} (${large.body?.error}). Large (8 vCPU) is exercised in the benchmark run.`,
      evidence: [log('nproc/mem', r.stdout)]
    }
  },

  'sub.disk': async (ctx) => {
    const p = await ctx.primary()
    const r = await ctx.exec(p.sandbox.session!.id, 'df -BG --output=size,avail /vercel/sandbox | tail -1')
    const [size, avail] = r.stdout.trim().split(/\s+/).map((v) => Number.parseInt(v, 10))
    return {
      status: (size ?? 0) >= 30 ? 'partial' : 'fail',
      detail: `disk ${size} GB (${avail} GB free). Conductor: 64 GB. Low-disk alert not yet probed (W1/W2).`,
      evidence: [log('df', r.stdout)]
    }
  },

  'sub.tools': async (ctx) => {
    const p = await ctx.primary()
    const tools = ['node', 'npm', 'pnpm', 'python3', 'git', 'gh', 'jq', 'rg', 'git-lfs', 'tmux', 'vim', 'claude', 'codex', 'orca', 'chromium', 'google-chrome']
    const r = await ctx.exec(p.sandbox.session!.id, LOGIN(`for t in ${tools.join(' ')}; do command -v $t >/dev/null 2>&1 && echo "$t=yes" || echo "$t=no"; done; node --version; claude --version 2>/dev/null | head -1; codex --version 2>/dev/null | head -1`))
    const have = new Set(r.stdout.split('\n').filter((l) => l.endsWith('=yes')).map((l) => l.slice(0, -4)))
    const missing = tools.filter((t) => !have.has(t))
    const required = ['node', 'git', 'gh', 'claude', 'codex']
    const requiredMissing = required.filter((t) => !have.has(t))
    return {
      status: requiredMissing.length ? 'fail' : missing.length ? 'partial' : 'pass',
      detail: `present: ${[...have].join(', ')}; missing: ${missing.join(', ') || 'none'}`,
      evidence: [log('login shell tools', r.stdout)]
    }
  },

  'sub.region': async (ctx) => {
    const p = await ctx.primary()
    const v = await vercelRest('GET', `/v2/sandboxes/orca-dev-${p.sandbox.id}`, { projectId: config.vercelProjectId })
    const region = v.json?.sandbox?.region ?? v.json?.region ?? null
    const view = await ctx.sandboxes.get(p.sandbox.id)
    const ok = (view.body?.sandbox as any)?.region === 'iad1'
    return { status: ok ? 'pass' : 'fail', detail: `control plane region ${(view.body?.sandbox as any)?.region}; Vercel reports ${region ?? 'n/a'}` }
  },

  'sub.github-clone': async (ctx) => {
    const p = await ctx.primary()
    const r = await ctx.exec(
      p.sandbox.session!.id,
      `cd ${p.connection.projectRoot} && git log --oneline -1 && git remote get-url origin && (grep -rIl "ghs_\\|ghp_\\|github_pat_" ~/.git-credentials ~/.config/gh .git/config 2>/dev/null | wc -l)`
    )
    const lines = r.stdout.trim().split('\n')
    const tokensOnDisk = Number(lines.at(-1))
    const ok = r.exitCode === 0 && /orca-sandbox-push-test/.test(r.stdout) && tokensOnDisk === 0
    return { status: ok ? 'pass' : 'fail', detail: `private repo cloned (${lines[0]}); GitHub tokens on disk: ${tokensOnDisk}`, evidence: [log('git', r.stdout)] }
  },

  'acc.terminal': async (ctx) => {
    const p = await ctx.primary()
    const t = await openTerminal(p.connection.pairingCode, p.connection.projectRoot)
    if (!t.handle) {
      return { status: 'fail', detail: `terminal create failed: ${t.term.stderr || JSON.stringify(t.term.json?.error)}` }
    }
    const echo = await typeAndSee(p.connection.pairingCode, t.handle, 'echo EVAL_$((6*7)) $(whoami) $(command -v claude)', 'EVAL_42')
    return {
      status: echo.ok ? 'pass' : 'fail',
      detail: `repo add ${t.repo.ms} ms, terminal create ${t.term.ms} ms, type->echo ${echo.ms} ms (via orca CLI; each CLI call reconnects E2EE)`,
      timingsMs: { repoAdd: t.repo.ms, terminalCreate: t.term.ms, typeToEcho: echo.ms },
      evidence: [log('terminal output tail', echo.output || echo.error)]
    }
  },

  'sec.git-push': async (ctx) => {
    const p = await ctx.primary()
    const branch = `w9-eval/${ctx.run.file.runId}`
    const r = await ctx.exec(
      p.sandbox.session!.id,
      LOGIN(
        `cd ${p.connection.projectRoot} && git checkout -qb ${branch} && echo "eval ${ctx.run.file.runId}" > EVAL.md && git add EVAL.md && git -c user.email=eval@orca.dev -c user.name="Orca eval" commit -qm "eval ${ctx.run.file.runId}" && S=$(date +%s%3N) && git push -q origin HEAD 2>&1 | tail -2; echo "push_rc=\${PIPESTATUS[0]} push_ms=$(( $(date +%s%3N) - S ))"; git push -q origin --delete ${branch} 2>&1 | tail -1; echo "delete_rc=\${PIPESTATUS[0]}"`
      ),
      120_000
    )
    const ok = /push_rc=0/.test(r.stdout) && /delete_rc=0/.test(r.stdout)
    const pushMs = Number(/push_ms=(\d+)/.exec(r.stdout)?.[1] ?? NaN)
    return { status: ok ? 'pass' : 'fail', detail: `push to ${branch}: ${ok ? 'ok' : 'failed'} in ${pushMs} ms, branch deleted after`, timingsMs: { push: pushMs }, evidence: [log('git push', r.stdout + r.stderr)] }
  },

  'sec.egress-deny': async (ctx) => {
    const p = await ctx.primary()
    const r = await ctx.exec(
      p.sandbox.session!.id,
      [
        `echo "unlisted: $(curl -s -m 10 -o /dev/null -w '%{http_code}' https://example.com; echo " rc=$?")"`,
        `echo "npm: $(curl -s -m 10 -o /dev/null -w '%{http_code}' https://registry.npmjs.org/)"`,
        `echo "attacker-token: $(curl -s -m 15 -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer ghp_attacker' https://api.github.com/rate_limit)"`,
        `echo "ai-gateway: $(curl -s -m 10 -o /dev/null -w '%{http_code}' https://ai-gateway.vercel.sh/v1/models; echo " rc=$?")"`
      ].join('\n')
    )
    const unlistedBlocked = /unlisted: 000 rc=(6|7|28|35)/.test(r.stdout)
    const npmOk = /npm: 200/.test(r.stdout)
    const attackerRefused = /attacker-token: 403/.test(r.stdout)
    const ok = unlistedBlocked && npmOk && attackerRefused
    return { status: ok ? 'pass' : 'fail', detail: `unlisted blocked=${unlistedBlocked}, npm=${npmOk}, foreign GitHub token refused=${attackerRefused}`, evidence: [log('egress', r.stdout)] }
  },

  'life.lease': async (ctx) => {
    const p = await ctx.primary()
    const before = p.sandbox.session!.leaseExpiresAt
    const r = await control.as(ctx.solo, 'POST', `/v1/sandboxes/${p.sandbox.id}/lease`, { extendMs: 30 * 60_000 })
    const after = r.body?.sandbox?.session?.leaseExpiresAt
    const tooLong = await control.as(ctx.solo, 'POST', `/v1/sandboxes/${p.sandbox.id}/lease`, { extendMs: 24 * 60 * 60_000 })
    const ok = r.status === 200 && after >= before && after <= r.body.sandbox.session.deadlineAt && tooLong.status === 400
    return { status: ok ? 'pass' : 'fail', detail: `lease ${r.status} (+${Math.round((after - before) / 1000)} s, <= deadline), oversize ${tooLong.status}`, timingsMs: { lease: r.ms } }
  },

  'life.sleep-wake': async (ctx) => {
    const p = await ctx.primary()
    const sid = p.sandbox.session!.id
    await ctx.exec(sid, `echo keep-${ctx.run.file.runId} > ${p.connection.projectRoot}/.w9-keep; sync`)
    const suspended = await ctx.sandboxes.suspend(p.sandbox.id)
    const resumed = await ctx.sandboxes.resume(p.sandbox.id)
    if (resumed.status !== 200) {
      return { status: 'fail', detail: `suspend ${suspended.status}, resume ${resumed.status} ${JSON.stringify(resumed.body)}` }
    }
    ctx.updatePrimary(resumed.body)
    const r = await ctx.exec(resumed.body.sandbox.session!.id, `cat ${p.connection.projectRoot}/.w9-keep`)
    const samePairing = pairingKey(resumed.body.connection.pairingCode) === pairingKey(p.connection.pairingCode)
    const st = await orca(resumed.body.connection.pairingCode, ['status'])
    const ok = suspended.status === 200 && r.stdout.trim() === `keep-${ctx.run.file.runId}` && samePairing && st.ok
    return {
      status: ok ? 'pass' : 'fail',
      detail: `suspend ${suspended.ms} ms (${suspended.body?.sandbox?.status}), resume->ready ${resumed.ms} ms, file kept=${r.stdout.trim() === `keep-${ctx.run.file.runId}`}, same host key=${samePairing}, CLI reconnect ${st.ms} ms`,
      timingsMs: { suspend: suspended.ms, resume: resumed.ms, reconnect: st.ms }
    }
  },

  'life.rollover': async (ctx) => {
    const p = await ctx.primary()
    await ctx.exec(p.sandbox.session!.id, `echo roll-${ctx.run.file.runId} > ${p.connection.projectRoot}/.w9-roll; sync`)
    const rolled = await ctx.sandboxes.rollover(p.sandbox.id)
    if (rolled.status !== 200) {
      return { status: 'fail', detail: `rollover ${rolled.status} ${JSON.stringify(rolled.body)}` }
    }
    ctx.updatePrimary(rolled.body)
    const r = await ctx.exec(rolled.body.sandbox.session!.id, `cat ${p.connection.projectRoot}/.w9-roll`)
    const samePairing = pairingKey(rolled.body.connection.pairingCode) === pairingKey(p.connection.pairingCode)
    const newSession = rolled.body.sandbox.session!.id !== p.sandbox.session!.id
    const st = await orca(rolled.body.connection.pairingCode, ['status'])
    const ok = newSession && samePairing && r.stdout.trim() === `roll-${ctx.run.file.runId}` && st.ok
    return {
      status: ok ? 'pass' : 'fail',
      detail: `rollover gap ${rolled.ms} ms (drain, stop, boot, orcad ready), new session=${newSession}, same host key=${samePairing}, file kept, CLI reconnect ${st.ms} ms`,
      timingsMs: { rollover: rolled.ms, reconnect: st.ms }
    }
  }
}

/** The host public key inside an orca://pair code: same key = no re-pair needed. */
export function pairingKey(code: string): string | null {
  try {
    const payload = new URL(code).searchParams.get('code')
    return (JSON.parse(Buffer.from(payload!, 'base64url').toString()) as { publicKeyB64?: string }).publicKeyB64 ?? null
  } catch {
    return null
  }
}
