// Wake delivery benchmark, headless, split into phases (n wakes of one workspace):
//   resume.vm      request sent -> orcad process spawned in the VM (Vercel resume + boot + start
//                  script; VM clock via /proc/<orcad>/stat starttime. Kernel uptime is not usable:
//                  it does not restart on a Vercel resume)
//   orcad.ready    orcad spawned -> control plane answers ready (orcad readiness + response)
//   firstList      ready -> first terminal.list over the E2EE pairing (includes the handshake)
//   termCreate     terminal.create (PTY + login shell)
//   echo           typed command -> echo seen (terminal.send / terminal.read polling)
//   total          request sent -> echo seen  ("wake delivery")
// transport=persistent (default): one paired connection per wake, reused for every call, as the
// desktop caches per environment (firstList carries the handshake). transport=cli: the CLI's
// RuntimeClient, which dials a fresh socket + E2EE handshake for every call (~1 RTT more each).
// Prints one JSON line.
//   <repo>/node_modules/.bin/tsx cloud/apps/acceptance/desktop/wake-split.ts [n=10] [machineSize=standard] [persistent|cli]
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RuntimeClient } from '../../../../src/cli/runtime/client'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../../../src/shared/electron-remote-runtime-client-capabilities'
import { pairedRuntimeConnectionFromOffer } from '../../../../src/shared/remote-runtime/pairing/paired-runtime-connection'
import { parsePairingCode } from '../../../../src/shared/remote-runtime/pairing/pairing'
import { RemoteRuntimeRequestConnection } from '../../../../src/shared/remote-runtime/requests/remote-runtime-request-connection'
import { control, vercel } from '../src/clients'
import { orca } from '../src/orca-cli'

const n = Number(process.argv[2] ?? 10)
const machineSize = (process.argv[3] ?? 'standard') as 'standard' | 'large'
const transport = process.argv[4] === 'cli' ? 'cli' : 'persistent'
type Caller = { call: <T>(method: string, params: unknown) => Promise<{ result: T }>; close: () => void }
function connect(pairingCode: string): Caller {
  if (transport === 'cli') {
    const client = new RuntimeClient(mkdtempSync(join(tmpdir(), 'orca-wake-')), 60_000, pairingCode, null)
    return { call: (method, params) => client.call(method, params), close: () => {} }
  }
  const connection = new RemoteRuntimeRequestConnection(
    pairedRuntimeConnectionFromOffer(parsePairingCode(pairingCode)!),
    ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
  )
  return {
    call: async <T,>(method: string, params: unknown) => {
      const response = (await connection.request(method, params, 60_000)) as { ok: boolean; result?: T; error?: { message?: string } }
      if (!response.ok) {
        throw new Error(`${method}: ${response.error?.message ?? 'failed'}`)
      }
      return { result: response.result as T }
    },
    close: () => connection.close()
  }
}
const who = { sub: 'w9-wake-split' }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const region = process.argv[5] && process.argv[5] !== '-' ? process.argv[5] : undefined
const cpus: string[] = []
const out: Record<string, number[]> = { 'resume.vm': [], 'orcad.ready': [], firstList: [], termCreate: [], echo: [], total: [], api: [] }
const errors: string[] = []

const created = await control.as(who, 'POST', '/v1/sandboxes', { workspaceId: `w9-wake-split-${Date.now()}`, machineSize, ...(region ? { region } : {}) })
if (created.status !== 200) {
  console.log(JSON.stringify({ error: `create ${created.status} ${JSON.stringify(created.body)}` }))
  process.exit(0)
}
const id = created.body.sandbox.id as string
const root = created.body.connection.projectRoot as string
try {
  // One-time setup (not timed): register the project so the worktree survives every wake on disk.
  await orca(created.body.connection.pairingCode, ['repo', 'add', '--path', root, '--kind', 'folder'])
  const t = await orca(created.body.connection.pairingCode, ['terminal', 'create', '--worktree', `path:${root}`, '--title', 'setup'])
  const worktree: string = t.json?.result?.terminal?.worktreeId
  if (!worktree) {
    throw new Error(`setup terminal failed: ${t.stderr.slice(0, 200)}`)
  }
  for (let i = 0; i < n; i++) {
    const s = await control.as(who, 'POST', `/v1/sandboxes/${id}/suspend`)
    if (s.status !== 200) {
      errors.push(`suspend ${s.status}`)
      continue
    }
    await sleep(2000)
    const t0 = Date.now()
    const w = await control.as(who, 'POST', `/v1/sandboxes/${id}/resume`)
    const t1 = Date.now()
    if (w.status !== 200) {
      errors.push(`resume ${w.status} ${w.body?.reason ?? ''}`)
      continue
    }
    const client = connect(w.body.connection.pairingCode)
    await client.call('terminal.list', { worktree })
    const t2 = Date.now()
    const term = await client.call<{ terminal: { handle: string } }>('terminal.create', { worktree, title: `wake-${i}` })
    const handle = term.result.terminal.handle
    const t2b = Date.now()
    const marker = `WAKE_${i}_${(i + 6) * 7}`
    await client.call('terminal.send', { terminal: handle, text: `echo WAKE_${i}_$(( (${i}+6)*7 ))`, enter: true, client: { id: 'orca-cli', type: 'desktop' } })
    let seen = false
    while (!seen && Date.now() - t2b < 30_000) {
      const r = await client.call<{ terminal: { tail?: string[] } }>('terminal.read', { terminal: handle })
      seen = JSON.stringify(r.result).includes(marker)
      if (!seen) {
        await sleep(50)
      }
    }
    const t3 = Date.now()
    client.close()
    if (!seen) {
      errors.push(`echo not seen (wake ${i})`)
      continue
    }
    // VM clock: boot epoch and orcad start epoch (10 ms resolution).
    const vm = await vercel().runCommand(w.body.sandbox.session.id, {
      command: 'bash',
      args: ['-c', `read up _ < /proc/uptime; now=$(date +%s.%N); hz=$(getconf CLK_TCK); st=$(awk '{print $22}' /proc/$(cat ~/.orca-sandbox/orcad.pid)/stat); echo "$now $up $st $hz"; grep -m1 'model name' /proc/cpuinfo | sed 's/.*: //'`],
      timeoutMs: 20_000
    })
    const [line1, cpuModel] = vm.stdout.trim().split('\n') as [string, string | undefined]
    cpus.push((cpuModel ?? '?').trim())
    const [now, up, st, hz] = line1.trim().split(/\s+/).map(Number) as [number, number, number, number]
    const bootMs = Math.round((now - up) * 1000)
    const orcadMs = bootMs + Math.round((st / hz) * 1000)
    out['resume.vm']!.push(orcadMs - t0)
    out['orcad.ready']!.push(t1 - orcadMs)
    out.api!.push(t1 - t0)
    out.firstList!.push(t2 - t1)
    out.termCreate!.push(t2b - t2)
    out.echo!.push(t3 - t2b)
    out.total!.push(t3 - t0)
    console.error(`wake ${i + 1}/${n}: total ${t3 - t0} (vm->orcad spawn ${orcadMs - t0}, orcad->ready ${t1 - orcadMs}, list ${t2 - t1}, create ${t2b - t2}, echo ${t3 - t2b})`)
  }
} catch (error) {
  errors.push(String(error instanceof Error ? error.message : error).slice(0, 300))
} finally {
  await control.as(who, 'DELETE', `/v1/sandboxes/${id}`)
}
console.log(JSON.stringify({ sandboxId: id, machineSize, region: region ?? "default", transport, samples: out, cpus, errors }))
process.exit(0)
