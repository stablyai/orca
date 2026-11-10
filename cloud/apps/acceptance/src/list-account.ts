// Lists the control-plane sandboxes of a dev account (default the harness's solo account).
//   tsx src/list-account.ts [sub] [--destroy]
import { control } from './clients'

const sub = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'w9-eval'
const who = { sub }
const list = await control.as(who, 'GET', '/v1/sandboxes')
for (const s of list.body?.sandboxes ?? []) {
  console.log(`${s.id}\t${s.workspaceId}\t${s.status}\t${new Date(s.createdAt).toISOString()}`)
  if (process.argv.includes('--destroy') && s.status !== 'destroyed') {
    console.log('  destroy', (await control.as(who, 'DELETE', `/v1/sandboxes/${s.id}`)).status)
  }
}
