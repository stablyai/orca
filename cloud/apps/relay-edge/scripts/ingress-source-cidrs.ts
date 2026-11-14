// The egress ranges a global load balancer uses to reach an internet NEG endpoint, for the edge's
// INGRESS_SOURCE_CIDRS. Published as an SPF-style TXT record; read here, never at request time.
//   npx tsx scripts/ingress-source-cidrs.ts                      # print the comma-separated list
//   npx tsx scripts/ingress-source-cidrs.ts --check "<deployed>" # exit 1 on drift (scheduled check)
import { Resolver } from 'node:dns/promises'
import { parseCidr } from '../src/ingress'

const RECORD = '_cloud-eoips.googleusercontent.com'

async function ranges(name: string, resolver: Resolver, depth = 0): Promise<string[]> {
  if (depth > 5) throw new Error(`include depth exceeded at ${name}`)
  const txt = (await resolver.resolveTxt(name)).map((chunks) => chunks.join('')).filter((t) => t.startsWith('v=spf1 '))
  if (txt.length !== 1) throw new Error(`expected one spf record at ${name}, got ${txt.length}`)
  const out: string[] = []
  for (const term of txt[0]!.split(/\s+/).slice(1)) {
    if (term.startsWith('ip4:') || term.startsWith('ip6:')) out.push(term.slice(4))
    else if (term.startsWith('include:')) out.push(...(await ranges(term.slice(8), resolver, depth + 1)))
  }
  return out
}

const normalize = (list: string[]) => [...new Set(list.map((c) => c.trim().toLowerCase()).filter(Boolean))].sort()

async function main(): Promise<void> {
  const resolver = new Resolver()
  resolver.setServers(['8.8.8.8', '8.8.4.4'])
  const published = normalize(await ranges(RECORD, resolver))
  if (published.length === 0 || published.some((c) => !parseCidr(c))) throw new Error(`unusable ranges: ${published.join(',')}`)
  const checkAt = process.argv.indexOf('--check')
  if (checkAt === -1) {
    console.log(published.join(','))
    return
  }
  const deployed = normalize((process.argv[checkAt + 1] ?? '').split(','))
  const added = published.filter((c) => !deployed.includes(c))
  const removed = deployed.filter((c) => !published.includes(c))
  if (added.length || removed.length) {
    console.error(JSON.stringify({ event: 'ingress_source_cidrs_drift', added, removed }))
    process.exitCode = 1
  } else console.log(`ok: ${published.length} ranges match`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
