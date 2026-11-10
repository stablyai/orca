// Lists every sandbox in Orca's Vercel project (status + tags) so stray eval resources are visible.
//   tsx src/list-provider.ts
import { vercel } from './clients'

const { sandboxes } = await vercel().listSandboxes()
for (const s of sandboxes) {
  console.log(`${s.name}\t${s.status}\t${JSON.stringify(s.tags)}`)
}
