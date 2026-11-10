// Real agent run in a cloud workspace: Claude Code (and Codex) talking to Vercel AI Gateway with the
// shared dev key, delivered the product way (personal secrets -> injected into orcad's env -> the
// terminal the agent runs in). One tiny task per run; model spend is read from the gateway.
import { control } from '../clients'
import { log, type Check } from '../context'
import { secrets } from '../env'
import { openTerminal, orca } from '../orca-cli'

const GATEWAY = 'https://ai-gateway.vercel.sh'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function credits(key: string): Promise<number | null> {
  const r = await fetch(`${GATEWAY}/v1/credits`, { headers: { authorization: `Bearer ${key}` } }).catch(() => null)
  const body = (await r?.json().catch(() => null)) as { balance?: string | number } | null
  return body?.balance !== undefined ? Number(body.balance) : null
}

export const agentChecks: Record<string, Check> = {
  'agent.real-task': async (ctx) => {
    const key = secrets.aiGatewayKey()
    if (!key) {
      return { status: 'skipped', detail: 'no AI Gateway key in the secrets dir' }
    }
    const who = { sub: `w9-agent-${ctx.run.file.runId}` }
    const env: Record<string, string> = {
      ANTHROPIC_BASE_URL: GATEWAY,
      ANTHROPIC_AUTH_TOKEN: key,
      ANTHROPIC_MODEL: 'moonshotai/kimi-k2',
      ANTHROPIC_SMALL_FAST_MODEL: 'openai/gpt-5-nano'
    }
    for (const [name, value] of Object.entries(env)) {
      const put = await control.as(who, 'PUT', `/v1/secrets/personal/${name}`, { value })
      if (put.status !== 200) {
        return { status: 'fail', detail: `secret ${name} -> ${put.status} ${JSON.stringify(put.body)}` }
      }
    }
    const before = await credits(key)
    const box = await ctx.sandboxes.create(who, { workspaceId: 'w9-agent' })
    try {
      if (box.status !== 200) {
        return { status: 'fail', detail: `create ${box.status}` }
      }
      const sid = box.body.sandbox.session!.id
      const root = box.body.connection.projectRoot
      // Fail fast (no model spend) when the VM cannot reach the gateway.
      const reach = await ctx.exec(sid, `curl -s -m 10 -o /dev/null -w '%{http_code}' ${GATEWAY}/v1/models; echo " rc=$?"`)
      if (!/^(200|401|403)/.test(reach.stdout.trim())) {
        return {
          status: 'fail',
          detail: `VM cannot reach ${GATEWAY} (${reach.stdout.trim()}): host is not on the sandbox egress allowlist, so gateway-backed agents cannot run`,
          evidence: [log('reachability', reach.stdout)]
        }
      }
      const t = await openTerminal(box.body.connection.pairingCode, root, 'folder')
      if (!t.handle) {
        return { status: 'fail', detail: `terminal ${t.term.stderr}` }
      }
      const prompt = 'Create a file named hello.txt in the current directory containing exactly the text orca-cloud-ok and nothing else. Do not do anything else.'
      const started = performance.now()
      await orca(box.body.connection.pairingCode, [
        'terminal', 'send', '--terminal', t.handle, '--enter',
        '--text', `cd ${root} && claude -p ${JSON.stringify(prompt)} --dangerously-skip-permissions > /tmp/agent.log 2>&1; echo AGENT_EXIT=$? >> /tmp/agent.log`
      ])
      let out = ''
      while (performance.now() - started < 240_000) {
        await sleep(5000)
        const r = await ctx.exec(sid, `cat /tmp/agent.log 2>/dev/null | tail -c 3000; echo; echo "FILE=$(cat ${root}/hello.txt 2>/dev/null)"`)
        out = r.stdout
        if (/AGENT_EXIT=/.test(out)) {
          break
        }
      }
      const ms = Math.round(performance.now() - started)
      const after = await credits(key)
      const spent = before !== null && after !== null ? (before - after).toFixed(4) : 'n/a'
      ctx.run.note(`agent.real-task gateway spend $${spent}`)
      const ok = /FILE=orca-cloud-ok/.test(out) && /AGENT_EXIT=0/.test(out)
      return {
        status: ok ? 'pass' : 'fail',
        detail: `Claude Code (${env.ANTHROPIC_MODEL} via AI Gateway, key injected from the secret store) ${ok ? 'created hello.txt' : 'did not finish the task'} in ${ms} ms; gateway spend $${spent}. Real Anthropic model run pending a credit top-up.`,
        timingsMs: { agentTask: ms },
        evidence: [log('agent log + file', out.replaceAll(key, '<key>'))]
      }
    } finally {
      for (const name of Object.keys(env)) {
        await control.as(who, 'DELETE', `/v1/secrets/personal/${name}`)
      }
      if (box.status === 200) {
        await ctx.sandboxes.destroy(box.body.sandbox.id)
      }
    }
  },

  'agent.signin': async (ctx) => {
    // An agent that is set up once stays set up: onboarding pre-seeded (#142), auth homes on the
    // workspace disk, and a working claude after sleep/wake and after a 24h-cap rollover.
    // Subscription OAuth can't run unattended, so a stand-in credentials file proves the auth home persists.
    const key = secrets.aiGatewayKey()
    if (!key) {
      return { status: 'skipped', detail: 'no AI Gateway key' }
    }
    const who = { sub: `w9-signin-${ctx.run.file.runId}` }
    const env: Record<string, string> = {
      ANTHROPIC_BASE_URL: GATEWAY,
      ANTHROPIC_AUTH_TOKEN: key,
      ANTHROPIC_MODEL: 'moonshotai/kimi-k2',
      ANTHROPIC_SMALL_FAST_MODEL: 'moonshotai/kimi-k2'
    }
    for (const [name, value] of Object.entries(env)) {
      await control.as(who, 'PUT', `/v1/secrets/personal/${name}`, { value })
    }
    const box = await ctx.sandboxes.create(who, { workspaceId: 'w9-signin' })
    const steps: string[] = []
    try {
      if (box.status !== 200) {
        return { status: 'fail', detail: `create ${box.status}` }
      }
      const id = box.body.sandbox.id
      let code = box.body.connection.pairingCode as string
      const root = box.body.connection.projectRoot as string
      const marker = `w9-${ctx.run.file.runId}`
      // Stand-in sign-in state in the CLIs' own auth homes (never real credentials).
      await ctx.exec(box.body.sandbox.session!.id, `mkdir -p ~/.claude ~/.codex && echo '{"w9":"${marker}"}' > ~/.claude/.w9-signin.json && echo '{"w9":"${marker}"}' > ~/.codex/.w9-signin.json`)
      const probe = async (label: string, sessionId: string) => {
        const t = await openTerminal(code, root, 'folder')
        if (!t.handle) {
          steps.push(`${label}: no terminal`)
          return false
        }
        await orca(code, ['terminal', 'send', '--terminal', t.handle, '--enter', '--text', `cd ${root} && claude -p "Reply with exactly: SIGNED-IN" > /tmp/signin-${label}.log 2>&1; echo EXIT=$? >> /tmp/signin-${label}.log`])
        let out = ''
        for (let i = 0; i < 24 && !/EXIT=/.test(out); i++) {
          await sleep(5000)
          out = (await ctx.exec(sessionId, `cat /tmp/signin-${label}.log 2>/dev/null | tail -c 400`)).stdout
        }
        const state = (await ctx.exec(sessionId, `node -e 'const c=require(require("os").homedir()+"/.claude.json");console.log(c.hasCompletedOnboarding)' 2>/dev/null; cat ~/.claude/.w9-signin.json ~/.codex/.w9-signin.json 2>/dev/null | grep -c ${marker}`)).stdout.trim().split('\n')
        const ok = /SIGNED-IN/.test(out) && /EXIT=0/.test(out) && state[0] === 'true' && state[1] === '2'
        steps.push(`${label}: claude ${/EXIT=0/.test(out) ? 'answered' : 'FAILED'}, onboarding ${state[0]}, auth homes ${state[1] === '2' ? 'kept' : 'LOST'}`)
        return ok
      }
      const okFresh = await probe('fresh', box.body.sandbox.session!.id)
      await ctx.sandboxes.suspend(id)
      const woke = await ctx.sandboxes.resume(id)
      code = woke.body.connection.pairingCode
      const okWake = woke.status === 200 && (await probe('after-wake', woke.body.sandbox.session!.id))
      const rolled = await ctx.sandboxes.rollover(id)
      code = rolled.body.connection.pairingCode
      const okRoll = rolled.status === 200 && (await probe('after-rollover', rolled.body.sandbox.session!.id))
      const ok = okFresh && okWake && okRoll
      return {
        status: ok ? 'pass' : 'fail',
        detail: `${steps.join('; ')}. Subscription OAuth itself needs a person; the auth homes it writes (~/.claude, ~/.codex) are shown to persist across sleep/wake and rollover.`
      }
    } finally {
      for (const name of Object.keys(env)) {
        await control.as(who, 'DELETE', `/v1/secrets/personal/${name}`)
      }
      if (box.status === 200) {
        await ctx.sandboxes.destroy(box.body.sandbox.id)
      }
    }
  },
  'image.agents': async (ctx) => {
    const p = await ctx.primary()
    const r = await ctx.exec(
      p.sandbox.session!.id,
      `bash -lc 'for t in claude codex cursor-agent opencode gemini copilot; do v=$(timeout 30 $t --version 2>/dev/null | head -1); echo "$t=\${v:-MISSING}"; done'`,
      180_000
    )
    const lines = r.stdout.trim().split('\n')
    const missing = lines.filter((l) => l.endsWith('=MISSING')).map((l) => l.split('=')[0])
    return {
      status: missing.length === 0 ? 'pass' : 'fail',
      detail: `agent CLIs on a fresh VM: ${lines.join('; ')}`,
      evidence: [log('--version', r.stdout)]
    }
  },

  'agent.keys-swap': async (ctx) => {
    // Gemini and Cursor without a real account: stand-in keys go through the egress swap. The VM only
    // ever holds placeholders; the provider sees the stand-in (and rejects it as invalid), and a
    // foreign key or a non-allowed path is refused by Orca's egress. No model call, no gateway credit.
    const tag = ctx.run.file.runId.replace(/[^0-9]/g, '').slice(-8)
    const who = { sub: `w9-keys-${tag}` }
    const stand = { GEMINI_API_KEY: `AIzaW9standin${tag}xxxxxxxxxxxxxxxxx`, CURSOR_API_KEY: `key_w9standin${tag}` }
    for (const [name, value] of Object.entries(stand)) {
      await control.as(who, 'PUT', `/v1/secrets/personal/${name}`, { value })
    }
    const box = await ctx.sandboxes.create(who, { workspaceId: `w9-keys-${tag}` })
    try {
      if (box.status !== 200) {
        return { status: 'fail', detail: `create ${box.status}` }
      }
      const sid = box.body.sandbox.session!.id
      const env = `eval "$(tr '\\0' '\\n' < /proc/$(cat ~/.orca-sandbox/orcad.pid)/environ | grep -E '^(GEMINI_API_KEY|CURSOR_API_KEY)=' | sed 's/^/export /')"`
      const r = await ctx.exec(
        sid,
        [
          env,
          `echo "gemini_placeholder=$([ "$GEMINI_API_KEY" != "${stand.GEMINI_API_KEY}" ] && [ -n "$GEMINI_API_KEY" ] && echo yes || echo no)"`,
          `echo "gemini_swap=$(curl -s -m 20 -H "x-goog-api-key: $GEMINI_API_KEY" 'https://generativelanguage.googleapis.com/v1beta/models' -o /tmp/g.json -w '%{http_code}') $(grep -o API_KEY_INVALID /tmp/g.json | head -1)"`,
          `echo "gemini_foreign=$(curl -s -m 20 -H 'x-goog-api-key: AIzaForeignKeyNotOursxxxxxxxxxxxxxxxx' 'https://generativelanguage.googleapis.com/v1beta/models' -o /tmp/gf.txt -w '%{http_code}') $(grep -o orca-egress-denied /tmp/gf.txt | head -1)"`,
          `echo "cursor_swap=$(curl -s -m 20 -X POST -H "Authorization: Bearer $CURSOR_API_KEY" -H 'content-type: application/json' -d '{}' https://api2.cursor.sh/auth/exchange_user_api_key -o /tmp/c.txt -w '%{http_code}') body=$(head -c 40 /tmp/c.txt)"`,
          `echo "cursor_other_path=$(curl -s -m 20 -H "Authorization: Bearer $CURSOR_API_KEY" https://api2.cursor.sh/some/other/path -o /tmp/c2.txt -w '%{http_code}') $(grep -o path_not_allowed /tmp/c2.txt | head -1)"`,
          // Keys off the VM: the stand-in values must appear nowhere, not in files, not in any process env.
          `echo "w9_marker=1" > /dev/null; files=$(grep -rIl -e '${stand.GEMINI_API_KEY}' -e '${stand.CURSOR_API_KEY}' /home /root /tmp /vercel /opt 2>/dev/null | wc -l)`,
          `procs=0; for f in /proc/[0-9]*/environ; do pid=$(basename $(dirname $f)); [ "$pid" = "$$" ] && continue; if tr '\\0' '\\n' < $f 2>/dev/null | grep -q -e '${stand.GEMINI_API_KEY}' -e '${stand.CURSOR_API_KEY}'; then procs=$((procs+1)); fi; done; echo "keys_in_files=$files keys_in_proc_env=$procs"`
        ].join('\n'),
        120_000
      )
      const o = r.stdout
      const placeholder = /gemini_placeholder=yes/.test(o)
      const geminiSwap = /gemini_swap=400 API_KEY_INVALID/.test(o)
      const geminiForeign = /gemini_foreign=403 orca-egress-denied/.test(o)
      const cursorSwap = /cursor_swap=401 body=\{\}/.test(o)
      const cursorPath = /cursor_other_path=403 path_not_allowed/.test(o)
      const offVm = /keys_in_files=0 keys_in_proc_env=0/.test(o)
      const ok = placeholder && geminiSwap && geminiForeign && cursorSwap && cursorPath && offVm
      return {
        status: ok ? 'pass' : 'fail',
        detail: `stand-in keys via the egress swap: VM holds placeholders=${placeholder}; Gemini real host saw the swapped key -> 400 API_KEY_INVALID=${geminiSwap}; foreign key -> 403 orca-egress-denied=${geminiForeign}; Cursor exchange with the placeholder -> 401 {}=${cursorSwap}; other Cursor path -> 403 path_not_allowed=${cursorPath}; stand-in values on the VM: ${/keys_in_files=(\d+) keys_in_proc_env=(\d+)/.exec(o)?.slice(1).join(' files / ') ?? '?'} procs`,
        evidence: [log('egress probes', o)]
      }
    } finally {
      for (const name of Object.keys(stand)) {
        await control.as(who, 'DELETE', `/v1/secrets/personal/${name}`)
      }
      if (box.status === 200) {
        await ctx.sandboxes.destroy(box.body.sandbox.id)
      }
    }
  },
}
