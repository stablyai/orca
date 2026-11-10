// Create benchmark with host facts: n sequential creates (no repo), each followed by a VM probe of
// CPU model, nproc and MemTotal, then destroy. Prints one JSON line.
//   <repo>/node_modules/.bin/tsx cloud/apps/acceptance/desktop/create-bench.ts [n=20] [machineSize=standard] [region|-]
import { control, vercel } from '../src/clients'

const n = Number(process.argv[2] ?? 20)
const machineSize = (process.argv[3] ?? 'standard') as 'standard' | 'large'
const region = process.argv[4] && process.argv[4] !== '-' ? process.argv[4] : undefined
const who = { sub: 'w9-create-bench' }
const samples: number[] = []
const hosts: Array<{ cpu: string; nproc: number; memGb: number; region: string | null }> = []
const errors: string[] = []
// The control plane allows 10 creates per minute per account: pace starts 6.5 s apart.
let lastStart = 0
for (let i = 0; i < n; i++) {
  await new Promise((res) => setTimeout(res, Math.max(0, lastStart + 6500 - Date.now())))
  lastStart = Date.now()
  const r = await control.as(who, 'POST', '/v1/sandboxes', { workspaceId: `w9-cb-${Date.now()}-${i}`, machineSize, ...(region ? { region } : {}) })
  if (r.status !== 200) {
    errors.push(`${r.status}:${r.body?.error}:${r.body?.reason ?? ''}`)
    continue
  }
  samples.push(r.ms)
  try {
    const vm = await vercel().runCommand(r.body.sandbox.session.id, {
      command: 'bash',
      args: ['-c', `grep -m1 'model name' /proc/cpuinfo | sed 's/.*: //'; nproc; awk '/MemTotal/{print $2}' /proc/meminfo`],
      timeoutMs: 20_000
    })
    const [cpu, nproc, memKb] = vm.stdout.trim().split('\n')
    hosts.push({ cpu: (cpu ?? '?').trim(), nproc: Number(nproc), memGb: Math.round((Number(memKb) / 1048576) * 10) / 10, region: r.body.sandbox.region ?? null })
  } finally {
    await control.as(who, 'DELETE', `/v1/sandboxes/${r.body.sandbox.id}`)
  }
  console.error(`create ${i + 1}/${n}: ${r.ms} ms ${hosts.at(-1)?.cpu} nproc=${hosts.at(-1)?.nproc} mem=${hosts.at(-1)?.memGb}GB ${hosts.at(-1)?.region}`)
}
console.log(JSON.stringify({ machineSize, region: region ?? 'default', samples: { 'create.api': samples }, hosts, errors }))
process.exit(0)
