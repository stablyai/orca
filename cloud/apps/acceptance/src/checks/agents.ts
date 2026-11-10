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
  }
}
